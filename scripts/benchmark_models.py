"""
Start Ollama first.
Make sure both models are installed:
ollama list
Then run:
python scripts/benchmark_models.py --runs 3
"""
import sys

try:
    import requests
    import psutil
except ImportError:
    print("pip install requests psutil")
    sys.exit(1)

import csv
import json
import subprocess
import pathlib
import argparse
import time
import base64
import os
import re
from datetime import datetime
from collections import defaultdict

OLLAMA_API_URL = "http://localhost:11434/api/generate"

# Benchmark test cases definitions based on resources
TEST_CASES_CONFIG = [
    {
        "test_id": "1",
        "test_name": "Debit card replacement status",
        "test_type": "json",
        "file_pattern": "08_debit_card_replacement_request.json",
        "question": "What is the status of my debit card replacement request?",
        "expected_keywords": ["Ready for confirmation", "9011", "Lost card", "Tunis Centre", "12.000 TND"]
    },
    {
        "test_id": "2",
        "test_name": "Telecom bill payment preparation",
        "test_type": "json",
        "file_pattern": "16_telecom_bill_payment_request.json",
        "question": "Pay my Telecom bill from acc_001. Prepare the action but do not execute it.",
        "expected_keywords": ["Tunisie Telecom", "TEL-2026-334219", "64.900 TND", "acc_001", "Unpaid", "confirmation"],
        "is_action": True
    },
    {
        "test_id": "3",
        "test_name": "Tunis branch directory",
        "test_type": "json",
        "file_pattern": "02_branch_directory_tunis_region.json",
        "question": "What branches are available in Tunis?",
        "expected_keywords": ["Tunis"]
    },
    {
        "test_id": "4",
        "test_name": "Mobile banking security notice",
        "test_type": "json",
        "file_pattern": "04_mobile_banking_security_notice.json",
        "question": "What does the mobile banking security notice recommend?",
        "expected_keywords": ["password"]
    },
    {
        "test_id": "5",
        "test_name": "Credit card limit",
        "test_type": "json",
        "file_pattern": "05_credit_card_limit_notice_card1122.json",
        "question": "What is my credit card limit?",
        "expected_keywords": ["1122"]
    },
    {
        "test_id": "6",
        "test_name": "TXT SMS alert",
        "test_type": "txt",
        "file_pattern": ".*sms.*alert.*\\.(txt|json)$",
        "question": "What happened in my SMS card alert?",
        "expected_keywords": []
    },
    {
        "test_id": "7",
        "test_name": "TXT wire transfer",
        "test_type": "txt",
        "file_pattern": ".*wire.*transfer.*\\.(txt|json)$",
        "question": "What is the status of my wire transfer to Canada?",
        "expected_keywords": []
    },
    {
        "test_id": "8",
        "test_name": "TXT direct debit",
        "test_type": "txt",
        "file_pattern": ".*direct.*debit.*\\.(txt|json)$",
        "question": "What direct debit mandates are active?",
        "expected_keywords": []
    },
    {
        "test_id": "9",
        "test_name": "Image QR receipt",
        "test_type": "image",
        "file_pattern": ".*qr.*receipt.*\\.(png|jpg|jpeg)$",
        "question": "Read the QR merchant payment receipt image.",
        "expected_keywords": []
    },
    {
        "test_id": "10",
        "test_name": "Image card activation notice",
        "test_type": "image",
        "file_pattern": ".*card.*activation.*\\.(png|jpg|jpeg)$",
        "question": "What is the status of my debit card activation notice?",
        "expected_keywords": []
    }
]

CSV_COLUMNS = [
    "timestamp", "test_id", "test_name", "test_type", "resource_path", "model", "run",
    "success", "status", "latency_ms", "total_duration_ms", "load_duration_ms",
    "prompt_eval_count", "eval_count", "tokens_per_second", "response_char_count",
    "cpu_before_percent", "cpu_after_percent", "ram_before_mb", "ram_after_mb",
    "gpu_vram_before_mb", "gpu_vram_after_mb", "score", "matched_keywords", "missing_keywords",
    "answer_preview", "error"
]

def get_sys_metrics():
    """Get CPU %, RAM MB, and GPU VRAM MB if nvidia-smi is available."""
    cpu = psutil.cpu_percent(interval=None)
    ram = psutil.virtual_memory().used / (1024 * 1024)
    gpu_vram = ""
    try:
        # Use nvidia-smi to get VRAM usage for the first GPU
        result = subprocess.run(
            ['nvidia-smi', '--query-gpu=memory.used', '--format=csv,nounits,noheader'],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0 and result.stdout.strip():
            gpu_vram = float(result.stdout.strip().split('\n')[0])
    except Exception:
        pass
    return cpu, ram, gpu_vram

def find_resource(base_dir, file_pattern):
    resources_dir = pathlib.Path(base_dir) / "resources"
    if not resources_dir.exists():
        return None
    
    # Try exact match first
    for root, _, files in os.walk(resources_dir):
        for f in files:
            if f == file_pattern:
                return os.path.join(root, f)
    
    # Try regex match
    try:
        regex = re.compile(file_pattern, re.IGNORECASE)
        for root, _, files in os.walk(resources_dir):
            for f in files:
                if regex.search(f):
                    return os.path.join(root, f)
    except Exception:
        pass
        
    return None

def load_resource_content(filepath, text_only=False):
    ext = filepath.lower().split('.')[-1]
    if ext in ['png', 'jpg', 'jpeg']:
        if text_only:
            return None
        with open(filepath, "rb") as image_file:
            return base64.b64encode(image_file.read()).decode('utf-8')
    else:
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                if ext == 'json':
                    return json.dumps(json.load(f), indent=2)
                return f.read()
        except Exception as e:
            return f"Error reading file: {str(e)}"

def score_answer(answer_text, expected_keywords):
    if not expected_keywords:
        return "", [], []
    
    answer_lower = answer_text.lower()
    matched = []
    missing = []
    
    for kw in expected_keywords:
        if kw.lower() in answer_lower:
            matched.append(kw)
        else:
            missing.append(kw)
            
    score = len(matched) / len(expected_keywords)
    return score, matched, missing

def run_benchmark(runs, models):
    base_dir = pathlib.Path(__file__).parent.parent.absolute()
    results_dir = base_dir / "benchmark_results"
    results_dir.mkdir(parents=True, exist_ok=True)
    
    csv_path = results_dir / "model_comparison.csv"
    json_path = results_dir / "model_answers.json"
    
    csv_file = open(csv_path, 'w', newline='', encoding='utf-8')
    csv_writer = csv.DictWriter(csv_file, fieldnames=CSV_COLUMNS)
    csv_writer.writeheader()
    
    all_answers = []
    skipped_tests = []
    summary_stats = defaultdict(lambda: defaultdict(list))
    
    print(f"Starting benchmark with models: {', '.join(models)} for {runs} runs.")
    
    for test in TEST_CASES_CONFIG:
        res_path = find_resource(base_dir, test["file_pattern"])
        
        if not res_path:
            skipped_tests.append({"test_id": test["test_id"], "test_name": test["test_name"], "reason": "Resource not found"})
            continue
            
        is_image_test = test["test_type"] == "image"
        
        for model in models:
            for run_idx in range(1, runs + 1):
                print(f"Running [{model}] - Run {run_idx}/{runs} - Test: {test['test_name']}")
                
                # Check vision compatibility
                if is_image_test and "vl" not in model.lower():
                    # For qwen2.5:7b on image test
                    row = {col: "" for col in CSV_COLUMNS}
                    row.update({
                        "timestamp": datetime.now().isoformat(),
                        "test_id": test["test_id"],
                        "test_name": test["test_name"],
                        "test_type": test["test_type"],
                        "resource_path": res_path,
                        "model": model,
                        "run": run_idx,
                        "success": False,
                        "status": "unsupported_vision_model",
                        "error": "Text model does not support direct image input",
                        "answer_preview": "[Skipped] Unsupported vision model"
                    })
                    csv_writer.writerow(row)
                    all_answers.append(row)
                    continue
                
                # Prepare Prompt
                if is_image_test:
                    base64_img = load_resource_content(res_path)
                    prompt = (
                        "You are ATB's digital banking assistant.\n"
                        "Read the banking resource image.\n"
                        "Extract the visible fields and answer the user question.\n"
                        "Do not invent missing values.\n"
                        "Preserve masked account/card values.\n\n"
                        f"User question:\n{test['question']}"
                    )
                    payload = {
                        "model": model,
                        "prompt": prompt,
                        "images": [base64_img],
                        "stream": False
                    }
                else:
                    context = load_resource_content(res_path)
                    action_instruction = "\nPrepare the action but do not execute it.\nMention that confirmation is required.\n" if test.get("is_action") else ""
                    
                    prompt = (
                        "You are ATB's digital banking assistant.\n"
                        "Use only the provided resource context.\n"
                        "Answer the user question accurately.\n"
                        "Do not invent missing data.\n"
                        "Mask sensitive values.\n"
                        f"{action_instruction}\n"
                        "Resource context:\n"
                        f"{context}\n\n"
                        "User question:\n"
                        f"{test['question']}"
                    )
                    payload = {
                        "model": model,
                        "prompt": prompt,
                        "stream": False
                    }
                
                cpu_before, ram_before, gpu_before = get_sys_metrics()
                start_time = time.time()
                
                error_msg = ""
                response_data = {}
                success = False
                status = "failed"
                
                try:
                    res = requests.post(OLLAMA_API_URL, json=payload, timeout=120)
                    res.raise_for_status()
                    response_data = res.json()
                    success = True
                    status = "success"
                except Exception as e:
                    error_msg = str(e)
                
                end_time = time.time()
                cpu_after, ram_after, gpu_after = get_sys_metrics()
                
                latency_ms = int((end_time - start_time) * 1000)
                answer_text = response_data.get('response', '')
                
                # Evaluation metrics from Ollama
                total_duration_ms = response_data.get('total_duration', 0) / 1e6
                load_duration_ms = response_data.get('load_duration', 0) / 1e6
                prompt_eval_count = response_data.get('prompt_eval_count', 0)
                eval_count = response_data.get('eval_count', 0)
                eval_duration = response_data.get('eval_duration', 0) / 1e9 # to seconds
                
                tokens_per_second = ""
                if eval_count and eval_duration > 0:
                    tokens_per_second = round(eval_count / eval_duration, 2)
                    
                score, matched, missing = score_answer(answer_text, test.get("expected_keywords", []))
                
                row = {
                    "timestamp": datetime.now().isoformat(),
                    "test_id": test["test_id"],
                    "test_name": test["test_name"],
                    "test_type": test["test_type"],
                    "resource_path": res_path,
                    "model": model,
                    "run": run_idx,
                    "success": success,
                    "status": status,
                    "latency_ms": latency_ms,
                    "total_duration_ms": int(total_duration_ms) if total_duration_ms else "",
                    "load_duration_ms": int(load_duration_ms) if load_duration_ms else "",
                    "prompt_eval_count": prompt_eval_count if prompt_eval_count else "",
                    "eval_count": eval_count if eval_count else "",
                    "tokens_per_second": tokens_per_second,
                    "response_char_count": len(answer_text),
                    "cpu_before_percent": cpu_before,
                    "cpu_after_percent": cpu_after,
                    "ram_before_mb": round(ram_before, 2),
                    "ram_after_mb": round(ram_after, 2),
                    "gpu_vram_before_mb": gpu_before,
                    "gpu_vram_after_mb": gpu_after,
                    "score": score,
                    "matched_keywords": ", ".join(matched),
                    "missing_keywords": ", ".join(missing),
                    "answer_preview": answer_text[:200].replace('\n', ' ') + "..." if len(answer_text) > 200 else answer_text.replace('\n', ' '),
                    "error": error_msg,
                    "full_answer": answer_text # Kept for JSON
                }
                
                # write CSV (without full answer to keep preview only)
                csv_row = row.copy()
                del csv_row["full_answer"]
                csv_writer.writerow(csv_row)
                csv_file.flush()
                
                all_answers.append(row)
                
                # Add to summary stats if successful
                if success:
                    cat = "image" if is_image_test else "text"
                    summary_stats[model][f"{cat}_latency"].append(latency_ms)
                    if isinstance(score, (int, float)):
                        summary_stats[model]["scores"].append(score)

    csv_file.close()
    
    with open(json_path, 'w', encoding='utf-8') as f:
        json.dump({
            "skipped_tests": skipped_tests,
            "results": all_answers
        }, f, indent=2)
        
    print("\n--- Benchmark Summary ---")
    if not summary_stats:
        print("No successful runs to summarize.")
        return
        
    for model in models:
        stats = summary_stats[model]
        if stats:
            avg_text_lat = sum(stats["text_latency"])/len(stats["text_latency"]) if stats["text_latency"] else 0
            avg_img_lat = sum(stats["image_latency"])/len(stats["image_latency"]) if stats["image_latency"] else 0
            avg_score = sum(stats["scores"])/len(stats["scores"]) if stats["scores"] else 0
            
            print(f"Model: {model}")
            print(f"  Average Text Latency : {avg_text_lat:.0f} ms")
            print(f"  Average Image Latency: {avg_img_lat:.0f} ms")
            print(f"  Average Score        : {avg_score:.2f}")

    print(f"\nResults saved to:")
    print(f" - {csv_path}")
    print(f" - {json_path}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Benchmark ATB AI models using Laragon resources")
    parser.add_argument("--runs", type=int, default=1, help="Number of times to run each test")
    parser.add_argument("--models", type=str, nargs="+", default=["qwen2.5:7b", "qwen3-vl:8b"], help="Models to benchmark")
    
    args = parser.parse_args()
    run_benchmark(args.runs, args.models)
