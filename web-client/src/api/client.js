import axios from 'axios';

const DEFAULT_BACKEND_API_URL = 'http://localhost:5000';
const FORBIDDEN_BACKEND_PORTS = new Set(['8000', '11434']);
const FORBIDDEN_BACKEND_PATHS = [
  '/agent/analyze',
  '/agent/decide',
  '/api/generate',
  '/atb-general-resources',
];

const getWindowOrigin = () =>
  typeof window !== 'undefined' && window.location?.origin
    ? window.location.origin
    : DEFAULT_BACKEND_API_URL;

const assertBackendApiBaseUrl = (value) => {
  const parsed = new URL(value || DEFAULT_BACKEND_API_URL, getWindowOrigin());
  const normalizedPath = parsed.pathname.toLowerCase();

  if (
    FORBIDDEN_BACKEND_PORTS.has(parsed.port) ||
    FORBIDDEN_BACKEND_PATHS.some((path) => normalizedPath.includes(path))
  ) {
    throw new Error(
      'VITE_API_URL must point to the Node.js backend, not the AI service, Ollama, or resource server.',
    );
  }

  return parsed.href.replace(/\/+$/, '');
};

const apiClient = axios.create({
  baseURL: assertBackendApiBaseUrl(import.meta.env.VITE_API_URL),
  headers: {
    'Content-Type': 'application/json',
  },
});

export default apiClient;
