const normalizeText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const normalizeResourceType = (value = '') =>
  normalizeText(value).replace(/\s+/g, '_');

const findResourceValue = (value, keys) => {
  if (value === null || value === undefined) return null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findResourceValue(item, keys);
      if (nested !== null && nested !== undefined && nested !== '') return nested;
    }
    return null;
  }

  if (typeof value !== 'object') return null;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [String(key).toLowerCase(), item]),
  );

  for (const key of keys) {
    const found = normalized[String(key).toLowerCase()];
    if (found !== null && found !== undefined && found !== '') return found;
  }

  for (const item of Object.values(value)) {
    const nested = findResourceValue(item, keys);
    if (nested !== null && nested !== undefined && nested !== '') return nested;
  }

  return null;
};

const formatValue = (value) => {
  if (Array.isArray(value)) {
    return value.map(formatValue).filter(Boolean).join(', ');
  }

  if (value && typeof value === 'object') {
    return Object.entries(value)
      .filter(([, item]) => item !== null && item !== undefined && item !== '')
      .map(([key, item]) => `${humanizeLabel(key)}: ${formatValue(item)}`)
      .join('; ');
  }

  return String(value || '').trim();
};

const humanizeLabel = (value = '') =>
  String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^./, (character) => character.toUpperCase());

const row = (label, value) => {
  const formatted = formatValue(value);
  return formatted ? `- **${label}:** ${formatted}` : null;
};

// Structured Markdown line: **Label:** value (no leading dash, used for short Q&A answers)
const line = (label, value) => {
  const formatted = formatValue(value);
  return formatted ? `**${label}:** ${formatted}` : null;
};

const isAmountQuestion = (text = '') =>
  /\b(how much|amount|total|cost|fee|limit|payment)\b/.test(text);

const isWhenQuestion = (text = '') =>
  /\b(when|date|time|deadline|due)\b/.test(text);

const isWhereQuestion = (text = '') =>
  /\b(where|branch|location|address|office)\b/.test(text);

const isStatusQuestionText = (text = '') =>
  /\b(status|active|ready|confirmed|paid|available|blocked|issued|pending|completed|settled|cleared|waiting)\b/.test(text);

const isRecommendedActionQuestion = (text = '') =>
  /\b(what should i do|next step|recommended|recommendation|action)\b/.test(text);

const INTERNAL_TEXT_FIELD_KEYS = new Set([
  'resourceid',
  'customerid',
  'environment',
  'localpathhint',
  'note',
  'synthetic',
  'url',
  'fileurl',
  'mimetype',
  'resourcetype',
]);

const normalizeFieldKey = (value = '') =>
  String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const camelCaseFieldKey = (value = '') => {
  const words = String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';
  return words
    .map((word, index) => {
      const lower = word.toLowerCase();
      return index === 0 ? lower : `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
    })
    .join('');
};

const parseResourceTextFields = (text = '') => {
  const fields = {};
  let inAgentNotes = false;

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const lineText = rawLine.trim();
    if (!lineText) continue;
    if (/^agent expected behavior\b/i.test(lineText)) {
      inAgentNotes = true;
      continue;
    }
    if (inAgentNotes) continue;
    if (/^(ATB DEMO TEXT RESOURCE|Synthetic text resource|Synthetic banking resource)/i.test(lineText)) {
      continue;
    }

    const match = lineText.match(/^([A-Za-z][A-Za-z0-9 _/-]{1,60})\s*:\s*(.+?)\s*$/);
    if (!match) continue;
    const key = camelCaseFieldKey(match[1]);
    const normalizedKey = normalizeFieldKey(key);
    if (!key || INTERNAL_TEXT_FIELD_KEYS.has(normalizedKey)) continue;
    const value = match[2].trim();
    if (value) fields[key] = value;
  }

  return fields;
};

const enrichResourceForAnswer = (resourceJson = {}) => ({
  ...resourceJson,
  ...parseResourceTextFields(
    resourceJson.fileText ||
    resourceJson.text ||
    resourceJson.body ||
    resourceJson.content ||
    '',
  ),
});

const boldValue = (value) => {
  const formatted = formatValue(value);
  return formatted ? `**${formatted}**` : null;
};

const boldMarkdownValue = (value) => {
  const formatted = formatValue(value);
  return formatted ? `**${formatted}**` : null;
};

const buildAtbConnectAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const title = findResourceValue(resourceJson, ['title']) || 'ATB Connect Activation Guide';
  const activationChannel = formatValue(findResourceValue(resourceJson, ['activationChannel', 'channel']));
  const requiredId = formatValue(findResourceValue(resourceJson, ['requiredId', 'requiredID', 'requiredDocument']));
  const stepsRaw = findResourceValue(resourceJson, ['activationSteps', 'steps', 'setupSteps']);
  const supportChannel = formatValue(findResourceValue(resourceJson, ['supportChannel', 'support']));

  const wantsActivation = /\b(activate|activation|how\s+(do|to)\s+(i\s+)?activate|set\s*up|first\s+login|onboard)\b/.test(text);

  if (wantsActivation && stepsRaw) {
    const stepList = Array.isArray(stepsRaw)
      ? stepsRaw.map((s, i) => `${i + 1}. ${formatValue(s)}`).filter(Boolean)
      : formatValue(stepsRaw).split(/[,;]/).map((s, i) => `${i + 1}. ${s.trim()}`).filter(Boolean);
    if (stepList.length) {
      const stepLine = stepList.join(', ');
      const meta = [activationChannel && `via **${activationChannel}**`, requiredId && `ID: **${requiredId}**`].filter(Boolean).join(' | ');
      return `To activate **${title}**: ${stepLine}.${meta ? ` (${meta})` : ''}`;
    }
  }

  const steps = Array.isArray(stepsRaw)
    ? stepsRaw.map(formatValue).filter(Boolean)
    : formatValue(stepsRaw).split(/[,;]/).map((step) => step.trim()).filter(Boolean);
  const lines = [
    `**${title}**`,
    activationChannel ? line('Activation channel', activationChannel) : null,
    requiredId ? line('Required ID', requiredId) : null,
    steps.length ? line('Steps', steps.join(', ')) : null,
    supportChannel ? line('Support', supportChannel) : null,
  ].filter(Boolean);

  return lines.length > 1 ? lines.join('\n') : null;
};

// Emphasise security keywords so the recommendation reads as actionable guidance,
// e.g. "Enable OTP" -> "Enable **One-Time Password (OTP)**".
const emphasizeSecurityTerms = (value = '') =>
  String(value || '')
    .replace(/\bOne-Time Password \(One-Time Password \(OTP\)\)/g, 'One-Time Password (OTP)')
    .replace(/\bOne-Time Password \(OTP\)/g, '__TRUSTED_OTP_EXPANSION__')
    .replace(/\bOTP\b/g, '**OTP**')
    .replace(/__TRUSTED_OTP_EXPANSION__/g, '**One-Time Password (OTP)**');

const buildSecurityNoticeAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'Mobile Banking Security Notice';
  const recommendationRaw = findResourceValue(resourceJson, [
    'recommendedAction',
    'recommendation',
    'recommendations',
    'advice',
  ]);
  if (!recommendationRaw) return null;
  const recommendation = emphasizeSecurityTerms(formatValue(recommendationRaw).replace(/\.$/, ''));

  // Natural-sounding answer (not a label/value dump): a lead sentence built from the real
  // recommendation, plus a short guidance sentence when the notice is about OTP credentials.
  let answer = `The **${title}** recommends: ${recommendation}.`;
  if (/otp|one-time password/i.test(formatValue(recommendationRaw))) {
    answer +=
      ' It also reminds you to never share your OTP code, use trusted devices to log in, and review your notifications so you can report any unknown transactions quickly.';
  }
  return answer;
};

const buildCardLimitAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'Credit Card Limit Notice';
  const cardValue = formatValue(findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber']));
  const currentLimit = findResourceValue(resourceJson, ['currentLimit']);
  const availableLimit = findResourceValue(resourceJson, ['availableLimit']);
  const statementDate = findResourceValue(resourceJson, ['statementDate']);
  const dueDate = findResourceValue(resourceJson, ['paymentDueDate', 'dueDate']);
  const minimumPayment = findResourceValue(resourceJson, ['minimumPayment']);

  const lines = [
    `**${title}**`,
    line('Card', cardValue),
    line('Current limit', currentLimit),
    line('Available limit', availableLimit),
    line('Minimum payment', minimumPayment),
    line('Statement date', statementDate),
    line('Payment due date', dueDate),
  ].filter(Boolean);

  return lines.length > 1 ? lines.join('\n') : null;
};

// Detects a SINGLE requested field on a Credit Card Limit Notice and answers only that field in a
// natural sentence (e.g. "Your available card limit is **1735.250 TND** for card **...1122**.")
// instead of dumping the whole notice. Returns null when no single field is clearly requested, so
// the caller falls back to the full notice summary.
const buildSpecificCardFieldAnswer = (message = '', resourceJson = {}) => {
  const text = normalizeText(message);
  if (!text) return null;

  const card = formatValue(findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber']));
  const cardSuffix = card ? ` for card ${boldMarkdownValue(card)}` : '';
  const minimumPayment = formatValue(findResourceValue(resourceJson, ['minimumPayment']));
  const paymentDueDate = formatValue(findResourceValue(resourceJson, ['paymentDueDate', 'dueDate']));

  if (
    minimumPayment &&
    paymentDueDate &&
    (
      /\b(still\s+)?(?:have|need)\s+to\s+pay\b/.test(text) ||
      /\bpay\s+(?:something|anything)\b/.test(text) ||
      /\banything\s+to\s+pay\b/.test(text) ||
      /\bnothing\s+to\s+pay\b/.test(text) ||
      /\bowe\b/.test(text)
    )
  ) {
    return `Yes. You need to pay at least **${minimumPayment}** by **${paymentDueDate}**${card ? ` for card ${boldMarkdownValue(card)}` : ''}.`;
  }

  if (/\bavailable\b.*\blimit\b|\blimit\b.*\bavailable\b/.test(text)) {
    const value = formatValue(findResourceValue(resourceJson, ['availableLimit']));
    return value ? `Your available card limit is **${value}**${cardSuffix}.` : null;
  }
  if (/\bcurrent\b.*\blimit\b|\blimit\b.*\bcurrent\b/.test(text)) {
    const value = formatValue(findResourceValue(resourceJson, ['currentLimit']));
    return value ? `Your current card limit is **${value}**${cardSuffix}.` : null;
  }
  if (/\bminimum\b.*\bpayment\b|\bmin\s+payment\b/.test(text)) {
    return minimumPayment ? `Your minimum card payment is **${minimumPayment}**.` : null;
  }
  if (/\bpayment\b.*\bdue\b|\bdue\b.*\bpayment\b|\bdue\s+date\b|\bwhen\b.*\bdue\b/.test(text)) {
    return paymentDueDate ? `Your card payment is due on **${paymentDueDate}**.` : null;
  }
  if (/\bstatement\s+date\b|\bstatement\b.*\bdate\b/.test(text)) {
    const value = formatValue(findResourceValue(resourceJson, ['statementDate']));
    return value ? `Your card statement date is **${value}**.` : null;
  }

  return null;
};

// Natural answer for the ATB Branch Directory, built from the parsed resource fields (region,
// branchCount, nearestBranch / defaultAppointmentBranch, supportPhone) instead of a bare
// title/category line. Returns null when none of those fields are present.
// Service keywords a user may ask a branch for. Used to match against each
// branch's `services` field so "which branch has SME support" resolves to the
// branch that actually lists that service (Lac 1), not the nearest/default one.
const BRANCH_SERVICE_TERMS = [
  'sme', 'premium', 'atm', 'loan', 'loans', 'card', 'cards', 'transfer',
  'transfers', 'deposit', 'deposits', 'appointment', 'appointments',
];

const parseBranchList = (resourceJson = {}) => {
  const raw = findResourceValue(resourceJson, ['branches']);
  return Array.isArray(raw) ? raw.filter((branch) => branch && typeof branch === 'object') : [];
};

// Branch hours are stored as "09:00-17:00"; render them as "09:00 to 17:00".
const formatBranchHours = (hours) => formatValue(hours).replace(/\s*-\s*/, ' to ');

const buildBranchDetailSentence = (branch = {}, { serviceLabel = null, asksLocation = false } = {}) => {
  const rawName = formatValue(branch.name);
  if (!rawName) return null;
  const subject = /\bbranch\b/i.test(rawName) ? `**${rawName}**` : `**${rawName}** branch`;
  const hours = formatBranchHours(branch.hours);
  const address = formatValue(branch.address);
  // Include the address only when the user actually asked where/location — a pure hours question
  // should answer just the hours.
  const details = [
    serviceLabel ? `provides **${serviceLabel}**` : null,
    hours ? `is open from **${hours}**` : null,
    !serviceLabel && asksLocation && address ? `is located at **${address}**` : null,
  ].filter(Boolean);
  return details.length ? `The ${subject} ${details.join(' and ')}.` : null;
};

// Find the branch whose `services` field contains a service term named in the
// query, and return the exact matched service segment as a label.
const findBranchByService = (branchList = [], text = '') => {
  const queryServiceTerms = BRANCH_SERVICE_TERMS.filter((term) => new RegExp(`\\b${term}\\b`).test(text));
  if (!queryServiceTerms.length) return null;
  for (const branch of branchList) {
    const segments = String(branch.services || '').split(/[,;]/).map((seg) => seg.trim()).filter(Boolean);
    const matchedSegment = segments.find((seg) =>
      queryServiceTerms.some((term) => normalizeText(seg).includes(term)));
    if (matchedSegment) {
      return { branch, serviceLabel: matchedSegment };
    }
  }
  return null;
};

const findBranchByName = (branchList = [], text = '') =>
  branchList.find((branch) => {
    const name = normalizeText(String(branch.name || ''));
    return name && text.includes(name);
  }) || null;

const branchServiceSegments = (branch = {}) =>
  String(branch.services || '')
    .split(/[,;]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

// Bold each item, join with commas + Oxford "and": ["a","b","c"] -> "**a**, **b**, and **c**".
const boldList = (items = []) => {
  const bolded = items.map((item) => `**${item}**`);
  if (bolded.length <= 1) return bolded.join('');
  if (bolded.length === 2) return `${bolded[0]} and ${bolded[1]}`;
  return `${bolded.slice(0, -1).join(', ')}, and ${bolded[bolded.length - 1]}`;
};

// Description-analysis step (deterministic): pick the SINGLE matching branch row for the question
// and return only that row's facts. This is what guards against row mixing — the model never gets
// the whole multi-row description, only the resolved row. Returns null when no row is selected.
const extractBranchFacts = (resourceJson = {}, message = '') => {
  const branchList = parseBranchList(resourceJson);
  if (!branchList.length) return null;
  const text = normalizeText(message);

  const asks = {
    services: /\b(services?|provide|provides|offer|offers|available|do you have)\b/.test(text),
    hours: /\b(hours?|open|opening|when|time|close|closing)\b/.test(text),
    location: /\b(where|location|address|located)\b/.test(text),
    phone: /\b(phone|contact|call|number)\b/.test(text),
    nearestOrDefault: /\b(nearest|closest|default|appointment)\b/.test(text),
  };

  const namedBranch = findBranchByName(branchList, text);
  const serviceMatch = asks.nearestOrDefault ? null : findBranchByService(branchList, text);

  let branch = null;
  let serviceLabel = null;
  let matchType = null;
  if (namedBranch) {
    branch = namedBranch;
    matchType = 'named_branch';
    if (serviceMatch && serviceMatch.branch === namedBranch) serviceLabel = serviceMatch.serviceLabel;
  } else if (serviceMatch) {
    branch = serviceMatch.branch;
    serviceLabel = serviceMatch.serviceLabel;
    matchType = 'service_row';
  }
  if (!branch) return null;

  return {
    branchName: formatValue(branch.name),
    services: branchServiceSegments(branch),
    hours: formatBranchHours(branch.hours),
    address: formatValue(branch.address),
    supportPhone: formatValue(findResourceValue(resourceJson, ['supportPhone', 'phone', 'contactPhone'])),
    serviceLabel,
    matchType,
    asks,
  };
};

// Deterministic answer from already-extracted single-row facts. Never mixes rows because it only
// ever sees one branch's facts.
const buildBranchAnswerFromFacts = (facts = {}, message = '') => {
  if (!facts || !facts.branchName) return null;
  const text = normalizeText(message);
  const subject = /\bbranch\b/i.test(facts.branchName)
    ? `**${facts.branchName}**`
    : `**${facts.branchName}** branch`;

  const parts = [];
  if (facts.serviceLabel) {
    // "Premium desk" reads better as "Premium desk service"; "SME support" already reads complete.
    const serviceWord =
      /\bservices?\b/.test(text) && !/\b(support|service)\b/i.test(facts.serviceLabel) ? ' service' : '';
    parts.push(`provides **${facts.serviceLabel}**${serviceWord}`);
  } else if (facts.asks.services && facts.services.length) {
    parts.push(`provides ${boldList(facts.services)}`);
  }

  // Hours: include for a service-location question or an explicit hours question; NOT for a plain
  // "what services" listing.
  const includeHours = facts.hours && (facts.asks.hours || Boolean(facts.serviceLabel));
  if (includeHours) parts.push(`is open from **${facts.hours}**`);

  // Address only for an explicit location question that is not a service question.
  if (facts.asks.location && !facts.serviceLabel && !facts.asks.services && facts.address) {
    parts.push(`is located at **${facts.address}**`);
  }
  if (facts.asks.phone && facts.supportPhone) {
    parts.push(`support is available at **${facts.supportPhone}**`);
  }

  return parts.length ? `The ${subject} ${parts.join(' and ')}.` : null;
};

const buildBranchDirectoryAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);

  // Phone query with no SPECIFIC branch named → return the directory-level support phone directly.
  // Requires the full normalized branch name to appear in the query (not just one word token),
  // so "Tunis branches" does not accidentally resolve to the "Tunis Centre" branch row.
  const asksPhone = /\b(phone|call|number|contact)\b/.test(text);
  const asksNearestOrDefault = /\b(nearest|closest|default|appointment)\b/.test(text);
  if (asksPhone && !asksNearestOrDefault) {
    const namedBranch = parseBranchList(resourceJson).find((b) => {
      const fullName = normalizeText(String(b.name || ''));
      return fullName.length > 3 && text.includes(fullName);
    });
    if (!namedBranch) {
      const supportPhone = formatValue(findResourceValue(resourceJson, ['supportPhone', 'phone', 'contactPhone']));
      const region = formatValue(findResourceValue(resourceJson, ['region']));
      if (supportPhone) {
        return `The${region ? ` ${region}` : ''} branch support phone is **${supportPhone}**.`;
      }
    }
  }

  // Branch-table answers come from the `branches` array first, via single-row extraction. Only fall
  // back to nearestBranch / defaultAppointmentBranch when the user explicitly asks for those.
  const branchList = parseBranchList(resourceJson);
  if (branchList.length && !asksNearestOrDefault) {
    const facts = extractBranchFacts(resourceJson, message);
    if (facts) {
      const answer = buildBranchAnswerFromFacts(facts, message);
      if (answer) return answer;
    }
  }

  const branchName = formatValue(
    findResourceValue(resourceJson, ['branchName', 'name', 'nearestBranch', 'defaultAppointmentBranch']),
  );
  const region = formatValue(findResourceValue(resourceJson, ['region']));
  const branchCount = findResourceValue(resourceJson, ['branchCount', 'branches']);
  const hours = formatValue(
    findResourceValue(resourceJson, ['hours', 'openingHours', 'openingHoursToday', 'workingHours']),
  );
  // Note: top-level `service` is the org code ("atb"), NOT branch services — do not read it here.
  const servicesValue = findResourceValue(resourceJson, ['services', 'availableServices']);
  const services = Array.isArray(servicesValue)
    ? servicesValue.map(formatValue).filter(Boolean).join(' and ')
    : formatValue(servicesValue);
  const address = formatValue(
    findResourceValue(resourceJson, ['address', 'location']),
  );
  const supportPhone = formatValue(
    findResourceValue(resourceJson, ['supportPhone', 'phone', 'contactPhone']),
  );

  const asksBranchDetails = /\b(hours?|open|opening|when|where|location|address|service|support|sme)\b/.test(text);
  if (asksBranchDetails && (branchName || hours || services || address)) {
    const subject = branchName
      ? (/\bbranch\b/i.test(branchName) ? branchName : `${branchName} branch`)
      : (region ? `${region} branch` : 'The branch');
    const details = [
      hours ? `is open from **${hours}**` : null,
      address ? `at **${address}**` : null,
      services ? `supports **${services}**` : null,
      supportPhone ? `support is available at **${supportPhone}**` : null,
    ].filter(Boolean);
    return details.length ? `The **${subject}** ${details.join(' and ')}.` : null;
  }

  const hasCount = branchCount !== null && branchCount !== undefined && branchCount !== '';
  const sentences = [];
  if (hasCount) {
    const count = formatValue(branchCount);
    const plural = String(count).trim() === '1' ? 'branch' : 'branches';
    sentences.push(
      region
        ? `The ${region} region has **${count} ${plural}** available.`
        : `There are **${count} ${plural}** available.`,
    );
  }
  if (branchName) {
    sentences.push(`The nearest/default appointment branch is **${branchName}**.`);
  }
  if (supportPhone) {
    sentences.push(`Support phone: **${supportPhone}**.`);
  }

  return sentences.length ? sentences.join(' ') : null;
};

// Debug-only: report which branch row / service the branch builder matched for a message, using
// the SAME matching logic as buildBranchDirectoryAnswer (no hardcoding). Returns names only.
const describeBranchMatch = (resourceJson = {}, message = '') => {
  const branchList = parseBranchList(resourceJson);
  if (!branchList.length) return { hasBranchesArray: false, matchedBranch: null, matchedService: null };
  const text = normalizeText(message);
  const asksNearestOrDefault = /\b(nearest|closest|default|appointment)\b/.test(text);
  if (!asksNearestOrDefault) {
    const serviceMatch = findBranchByService(branchList, text);
    if (serviceMatch) {
      return {
        hasBranchesArray: true,
        matchedBranch: formatValue(serviceMatch.branch.name) || null,
        matchedService: serviceMatch.serviceLabel || null,
      };
    }
    const namedBranch = findBranchByName(branchList, text);
    if (namedBranch) {
      return { hasBranchesArray: true, matchedBranch: formatValue(namedBranch.name) || null, matchedService: null };
    }
  }
  return { hasBranchesArray: true, matchedBranch: null, matchedService: null };
};

const buildLoanOfferAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'Personal Loan Offer - Student Pack';
  const durationMin = findResourceValue(resourceJson, ['minDurationMonths', 'durationMinMonths']);
  const durationMax = findResourceValue(resourceJson, ['maxDurationMonths', 'durationMaxMonths']);
  const duration = findResourceValue(resourceJson, ['duration', 'repaymentDuration']) ||
    (durationMin && durationMax ? `${durationMin} to ${durationMax} months` : null);
  const rows = [
    row('Maximum amount', findResourceValue(resourceJson, ['maxAmount', 'maximumAmount', 'loanAmount', 'amount'])),
    row('Duration', duration),
    row('Estimated rate', findResourceValue(resourceJson, ['estimatedRate', 'rate', 'interestRate'])),
    row('Monthly payment example', findResourceValue(resourceJson, ['monthlyPaymentExample', 'exampleMonthlyPayment', 'monthlyPayment'])),
    row('Status', findResourceValue(resourceJson, ['status'])),
  ].filter(Boolean);

  return rows.length
    ? [`I found your **${title}**.`, '', ...rows].join('\n')
    : null;
};

const splitListValue = (value) => {
  if (Array.isArray(value)) return value.map(formatValue).filter(Boolean);
  return formatValue(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

const buildProductSheetAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['productName', 'title']) || 'banking product';
  const includes = splitListValue(findResourceValue(resourceJson, ['includes', 'includedServices', 'benefits']));
  const monthlyFee = findResourceValue(resourceJson, ['monthlyFee', 'fee']);
  const status = findResourceValue(resourceJson, ['status', 'availability']);
  const target = findResourceValue(resourceJson, ['target', 'customerSegment']);

  const paragraphs = [];
  if (includes.length) {
    paragraphs.push(`The **${formatValue(title)}** includes ${boldList(includes)}.`);
  } else {
    paragraphs.push(`The product is **${formatValue(title)}**.`);
  }

  const details = [
    monthlyFee ? `The monthly fee is **${formatValue(monthlyFee)}**.` : null,
    target ? `It is designed for **${formatValue(target)}**.` : null,
    status ? `Status: **${formatValue(status)}**.` : null,
  ].filter(Boolean);

  return [...paragraphs, ...(details.length ? ['', details.join(' ')] : [])].join('\n');
};

// A resource is a RECEIPT (proof of an already-made payment) when its type/title says "receipt".
const isReceiptResource = (resourceJson = {}) => {
  const type = normalizeResourceType(resourceJson.resourceType || resourceJson.type);
  const title = normalizeText(findResourceValue(resourceJson, ['title']));
  return /receipt/.test(type) || /\breceipt\b/.test(title);
};

// The trusted status already marks the bill as settled (nothing left to pay).
const isPaidStatus = (resourceJson = {}) => {
  const status = normalizeText(formatValue(findResourceValue(resourceJson, ['status'])));
  return /\b(paid|settled|cleared|completed)\b/.test(status);
};

// A bill resource is NOT a valid source for preparing a NEW payment when it is a receipt or its
// status is already Paid/settled. The action layer uses this to refuse pay_bill on a paid receipt.
const isAlreadyPaidOrReceiptResource = (resourceJson = {}) =>
  isReceiptResource(resourceJson) || isPaidStatus(resourceJson);

const buildBillPaymentRequestAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const provider = findResourceValue(resourceJson, ['provider', 'biller', 'merchant']);
  const title = findResourceValue(resourceJson, ['title']) || `${provider || 'Bill'} Payment Request`;
  const reference = findResourceValue(resourceJson, ['billReference', 'billRef', 'invoiceReference', 'reference']);
  const amount = findResourceValue(resourceJson, ['amount', 'totalAmount', 'amountDue', 'total']);
  const dueDate = findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline']);
  const status = findResourceValue(resourceJson, ['status']);

  const formattedProvider = formatValue(provider);
  const formattedAmount = formatValue(amount);
  const formattedDueDate = formatValue(dueDate);
  const formattedStatus = formatValue(status);
  const formattedReference = formatValue(reference);

  // Safety: if the user wants to PAY but the matched record is a receipt / already Paid, do not
  // present it as payable. Explain it is already settled and ask which unpaid bill they mean.
  if (/\b(pay|settle|payer|regler)\b/.test(text) && isAlreadyPaidOrReceiptResource(resourceJson)) {
    return `The available **${formattedProvider || title}** record is a payment receipt and is already marked **${formattedStatus || 'Paid'}**, so there is nothing to pay on it. If you want to pay a different bill, tell me which unpaid bill or provider (for example **SONEDE** or **Tunisie Telecom**).`;
  }

  if (isAmountQuestion(text) && formattedAmount) {
    return `The amount is **${formattedAmount}**${formattedProvider ? ` for **${formattedProvider}**` : ''}${formattedDueDate ? `, due on **${formattedDueDate}**` : ''}.`;
  }
  if (isWhenQuestion(text) && formattedDueDate) {
    return `The due date is **${formattedDueDate}**${formattedAmount ? ` for the **${formattedAmount}** payment` : ''}${formattedProvider ? ` to **${formattedProvider}**` : ''}.`;
  }
  if (isStatusQuestionText(text) && formattedStatus) {
    return `The payment status is **${formattedStatus}**${formattedProvider ? ` for **${formattedProvider}**` : ''}${formattedAmount ? `, amount **${formattedAmount}**` : ''}.`;
  }

  const lines = [
    `**${title}**`,
    line('Provider', provider),
    line('Amount', amount),
    line('Reference', reference),
    line('Due date', dueDate),
    line('Status', status),
  ].filter(Boolean);

  return lines.length > 1 ? lines.join('\n') : null;
};

const buildCheckbookRequestAnswer = (resourceJson = {}) => {
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const readyDate = formatValue(findResourceValue(resourceJson, ['estimatedReadyDate', 'readyDate']));
  const branch = formatValue(findResourceValue(resourceJson, ['requestedBranch', 'branch', 'branchName']));
  if (!status && !readyDate && !branch) return null;

  return [
    `Your checkbook is ${status ? `still **${status.toLowerCase()}**` : 'being processed'}`,
    readyDate ? `and is estimated to be ready on **${readyDate}**` : null,
    branch ? `at **${branch}**` : null,
  ].filter(Boolean).join(' ') + '.';
};

const buildAppointmentConfirmationAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const purpose = formatValue(findResourceValue(resourceJson, ['purpose']));
  const branch = formatValue(findResourceValue(resourceJson, ['branch', 'branchName', 'location']));
  const date = formatValue(findResourceValue(resourceJson, ['date', 'appointmentDate', 'requestedDate']));
  const time = formatValue(findResourceValue(resourceJson, ['time', 'appointmentTime', 'requestedTime']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const advisor = formatValue(findResourceValue(resourceJson, ['advisor', 'advisorName']));
  if (!date && !time && !branch && !status) return null;

  const subject = purpose && /card pickup/i.test(purpose)
    ? 'Your card pickup appointment'
    : 'Your appointment';
  if (isWhenQuestion(text) || /appointment|pickup/.test(text)) {
    return [
      `${subject} is ${status ? `**${status.toLowerCase()}**` : 'scheduled'}`,
      date ? `for **${date}**` : null,
      time ? `at **${time}**` : null,
      branch ? `at **${branch}**` : null,
      advisor ? `with **${advisor}**` : null,
    ].filter(Boolean).join(' ') + '.';
  }

  return buildGenericResourceAnswer(resourceJson, message);
};

const buildSmsAlertAnswer = (resourceJson = {}) => {
  const card = formatValue(findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber']));
  const merchant = formatValue(findResourceValue(resourceJson, ['merchant']));
  const amount = formatValue(findResourceValue(resourceJson, ['amount']));
  const date = formatValue(findResourceValue(resourceJson, ['date']));
  const time = formatValue(findResourceValue(resourceJson, ['time']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const recommendedAction = formatValue(findResourceValue(resourceJson, ['recommendedAction', 'recommendation']));
  if (!merchant && !amount && !card) return null;

  const parts = [];
  if (merchant || amount) {
    parts.push(
      `Your SMS card alert was for ${merchant ? `a transaction at **${merchant}**` : 'a card transaction'}${amount ? ` for **${amount}**` : ''}.`,
    );
  }
  const details = [
    card ? `card ${boldMarkdownValue(card)}` : null,
    date ? `on **${date}**` : null,
    time ? `at **${time}**` : null,
  ].filter(Boolean).join(' ');
  if (details) parts.push(`It was recorded ${details}.`);
  if (status) parts.push(`The alert status is **${status}**.`);
  if (recommendedAction) parts.push(`The next step is **${recommendedAction}**.`);
  return parts.join(' ');
};

const buildWireTransferNoticeAnswer = (resourceJson = {}) => {
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const country = formatValue(findResourceValue(resourceJson, ['destinationCountry', 'country']));
  const amount = formatValue(findResourceValue(resourceJson, ['amount']));
  const beneficiary = formatValue(findResourceValue(resourceJson, ['beneficiaryName', 'beneficiary']));
  const fee = formatValue(findResourceValue(resourceJson, ['feeEstimate', 'estimatedFee', 'fee']));
  const purpose = formatValue(findResourceValue(resourceJson, ['purpose']));
  if (!status && !amount && !beneficiary) return null;
  return [
    `Your wire transfer${country ? ` to ${country}` : ''} is currently **${status || 'under review'}**.`,
    `It is for ${amount ? `**${amount}**` : 'the recorded amount'}${beneficiary ? ` to **${beneficiary}**` : ''}${fee ? `, with an estimated fee of **${fee}**` : ''}${purpose ? `, and the purpose is **${purpose.toLowerCase()}**` : ''}.`,
  ].join(' ');
};

const buildAtbConnectLoginErrorAnswer = (resourceJson = {}) => {
  const serviceName = formatValue(findResourceValue(resourceJson, ['serviceName'])) || 'ATB Connect';
  const errorCode = formatValue(findResourceValue(resourceJson, ['errorCode', 'code']));
  const issue = formatValue(findResourceValue(resourceJson, ['issue', 'reason']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const recommendedAction = formatValue(findResourceValue(resourceJson, ['recommendedAction', 'recommendation']));
  if (!errorCode && !issue && !status) return null;
  return [
    `Your ${serviceName} access is **${(status || 'temporarily locked').toLowerCase()}** because ${issue ? `the **${issue.toLowerCase()}** condition was reached` : 'the OTP attempts were exceeded'}.`,
    errorCode ? `The error code is **${errorCode}**.` : null,
    recommendedAction ? `The recommended step is to **${recommendedAction.replace(/\.$/, '')}**.` : null,
  ].filter(Boolean).join(' ');
};

const buildDirectDebitMandateAnswer = (resourceJson = {}) => {
  const merchant = formatValue(findResourceValue(resourceJson, ['merchant', 'provider']));
  const sourceAccount = formatValue(findResourceValue(resourceJson, ['sourceAccountId', 'accountId']));
  const amountLimit = formatValue(findResourceValue(resourceJson, ['amountLimit', 'limit', 'amount']));
  const frequency = formatValue(findResourceValue(resourceJson, ['frequency']));
  const nextDebitDate = formatValue(findResourceValue(resourceJson, ['nextDebitDate', 'dueDate']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  if (!merchant && !amountLimit && !nextDebitDate) return null;
  return `You have an **${(status || 'active').toLowerCase()}** ${frequency ? `${frequency.toLowerCase()} ` : ''}direct debit mandate for **${merchant || 'the merchant'}**${sourceAccount ? ` from **${sourceAccount}**` : ''}. ${amountLimit ? `The amount limit is **${amountLimit}**` : 'The amount limit is recorded'}${nextDebitDate ? `, and the next debit date is **${nextDebitDate}**` : ''}.`;
};

const buildBeneficiaryProfileAnswer = (resourceJson = {}) => {
  const name = formatValue(findResourceValue(resourceJson, ['beneficiaryName', 'name', 'fullName']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const beneficiaryId = formatValue(findResourceValue(resourceJson, ['beneficiaryId', 'id']));
  const bank = formatValue(findResourceValue(resourceJson, ['bank']));
  const account = formatValue(findResourceValue(resourceJson, ['accountNumber', 'maskedAccount', 'account']));
  const relationship = formatValue(findResourceValue(resourceJson, ['relationship']));
  if (!name && !beneficiaryId && !account) return null;
  const detailParts = [
    beneficiaryId ? `the beneficiary ID is **${beneficiaryId}**` : null,
    bank ? `the bank is **${bank}**` : null,
    account ? `the masked account is ${boldMarkdownValue(account)}` : null,
    relationship ? `the relationship is **${relationship}**` : null,
  ].filter(Boolean);
  return [
    `**${name || 'This beneficiary'}** is saved as a **${(status || 'trusted beneficiary').toLowerCase()}**.`,
    detailParts.length ? `${detailParts.join(', ')}.` : null,
  ].filter(Boolean).join(' ');
};

const buildBusinessAccountChecklistAnswer = (resourceJson = {}) => {
  const accountType = formatValue(
    findResourceValue(resourceJson, ['accountType', 'product', 'serviceName']),
  ) || 'business account';
  const requiredDocuments = findResourceValue(resourceJson, [
    'requiredDocuments',
    'documents',
    'documentChecklist',
    'checklist',
  ]);
  const requiredDocumentValues = Array.isArray(requiredDocuments)
    ? requiredDocuments.map(formatValue).filter(Boolean)
    : formatValue(requiredDocuments)
      .split(/\s*,\s*/)
      .map((item) => item.trim())
      .filter(Boolean);
  const directDocumentValues = [
    findResourceValue(resourceJson, ['businessRegistration', 'registrationDocument']),
    findResourceValue(resourceJson, ['taxIdCertificate', 'taxCertificate']),
    findResourceValue(resourceJson, ['ownerCin', 'ownerCIN', 'ownerNationalId', 'requiredId']),
  ].map(formatValue).filter(Boolean);
  const documents = Array.from(new Set([...requiredDocumentValues, ...directDocumentValues]));
  const proofOfAddress = formatValue(findResourceValue(resourceJson, ['proofOfAddress', 'addressProof']));
  const supportBranch = formatValue(findResourceValue(resourceJson, ['supportBranch', 'branch']));
  const optionalRaw = findResourceValue(resourceJson, ['optionalDocuments', 'optionalDocs']);
  const optionalDocuments = Array.isArray(optionalRaw)
    ? optionalRaw.map(formatValue).filter(Boolean)
    : formatValue(optionalRaw).split(/\s*,\s*/).map((item) => item.trim()).filter(Boolean);

  if (!documents.length && !proofOfAddress && !supportBranch) return null;

  // List ALL required documents (acronyms like CIN are copied verbatim — never expanded here).
  const documentText = documents.length
    ? documents.map((item) => `**${item}**`).join(', ').replace(/, ([^,]+)$/, ', and $1')
    : null;
  const details = [];
  if (optionalDocuments.length) {
    details.push(`a **${optionalDocuments.join('**, **')}** is optional`);
  }
  if (proofOfAddress && !documents.some((doc) => /proof of address/i.test(doc))) {
    details.push(`a **${proofOfAddress}** may also be requested`);
  }
  if (supportBranch) details.push(`the support branch is **${supportBranch}**`);

  const lead = documentText
    ? `To open a ${accountType} with ATB, you need ${documentText}.`
    : `To open a ${accountType} with ATB, use the checklist details in the resource.`;
  return details.length ? `${lead} For completeness, ${details.join(', and ')}.` : lead;
};

const buildGenericResourceAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const title = findResourceValue(resourceJson, ['title']) || 'Resource';
  const status = formatValue(findResourceValue(resourceJson, ['status']));
  const amount = formatValue(findResourceValue(resourceJson, ['amount', 'totalAmount', 'amountDue', 'total']));
  const dueDate = formatValue(findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline', 'nextDebitDate']));
  const location = formatValue(findResourceValue(resourceJson, ['branch', 'branchName', 'location', 'address']));
  const person = formatValue(findResourceValue(resourceJson, ['beneficiaryName', 'name', 'fullName', 'owner']));
  const recommendedAction = formatValue(findResourceValue(resourceJson, ['recommendedAction', 'recommendation', 'recommendedStep']));

  if (isStatusQuestionText(text) && status) {
    return `The status is **${status}**${dueDate ? `, with a deadline of **${dueDate}**` : ''}.`;
  }
  if (isAmountQuestion(text) && amount) {
    return `The amount is **${amount}**${dueDate ? `, due on **${dueDate}**` : ''}.`;
  }
  if (isWhenQuestion(text) && dueDate) {
    return `The date is **${dueDate}**${status ? ` and the status is **${status}**` : ''}.`;
  }
  if (isWhereQuestion(text) && location) {
    return `The location is **${location}**${status ? ` and the status is **${status}**` : ''}.`;
  }
  if (/\bwho\b/.test(text) && person) {
    return `The person is **${person}**${status ? `, with status **${status}**` : ''}.`;
  }
  if (isRecommendedActionQuestion(text) && recommendedAction) {
    return `The recommended action is **${recommendedAction}**${status ? ` The status is **${status}**.` : '.'}`;
  }
  // Lead with the bold title only (no "I found ..." preamble — that phrasing is reserved for
  // explicit find/show/open requests), then the supporting fields as bold-label lines.
  const detailLines = [
    ['status', 'status'],
    ['amount', 'amount'],
    ['provider', 'provider'],
    ['merchant', 'merchant'],
    ['beneficiaryName', 'beneficiary'],
    ['sourceAccountId', 'source account'],
    ['dueDate', 'due date'],
    ['nextDebitDate', 'next debit date'],
    ['recommendedAction', 'recommended step'],
  ]
    .map(([key, label]) => {
      const value = formatValue(findResourceValue(resourceJson, [key]));
      return value ? `the ${label} is **${value}**` : null;
    })
    .filter(Boolean);

  // Only a bold title with no real content is not a useful answer — signal "nothing structured".
  if (!detailLines.length) return null;
  return `For **${title}**, ${detailLines.join(', ')}.`;
};

const buildSavingsGoalProgressAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const goalName = formatValue(findResourceValue(resourceJson, ['goalName', 'name', 'goal']));
  const targetAmount = formatValue(findResourceValue(resourceJson, ['targetAmount', 'target', 'amount']));
  const savedAmount = formatValue(findResourceValue(resourceJson, ['savedAmount', 'saved', 'savedSoFar']));
  const progress = formatValue(findResourceValue(resourceJson, ['progress', 'percentage', 'percent']));
  const targetDate = formatValue(findResourceValue(resourceJson, ['targetDate', 'dueDate', 'deadline']));
  const status = formatValue(findResourceValue(resourceJson, ['status']));

  if (!goalName && !savedAmount && !progress) return null;

  if (isAmountQuestion(text) && savedAmount) {
    return `You have saved **${savedAmount}**${targetAmount ? ` of **${targetAmount}**` : ''}${progress ? ` (**${progress}**)` : ''}${goalName ? ` toward your **${goalName}** goal` : ''}.`;
  }
  if (isStatusQuestionText(text) && status) {
    return `Your${goalName ? ` **${goalName}**` : ''} savings goal is **${status}** — **${savedAmount || ''}**${targetAmount ? ` of **${targetAmount}**` : ''}${progress ? ` (${progress})` : ''}${targetDate ? ` by **${targetDate}**` : ''}.`;
  }

  return `Your **${goalName || 'savings'}** goal: saved **${savedAmount || '?'}**${targetAmount ? ` of **${targetAmount}**` : ''} (${progress || '?'} complete), status **${status || 'unknown'}**${targetDate ? `, target date **${targetDate}**` : ''}.`;
};

const buildCustomerProfileAnswer = (resourceJson = {}, message = '') => {
  const text = normalizeText(message);
  const phone = formatValue(findResourceValue(resourceJson, ['phone', 'profilePhone', 'contactPhone']));
  const email = formatValue(findResourceValue(resourceJson, ['email', 'profileEmail']));
  const fullName = formatValue(findResourceValue(resourceJson, ['fullName', 'name', 'customerName']));
  const primaryBranch = formatValue(findResourceValue(resourceJson, ['primaryBranch', 'branch', 'homeBranch']));
  const segment = formatValue(findResourceValue(resourceJson, ['segment', 'customerSegment']));
  const preferredLanguage = formatValue(findResourceValue(resourceJson, ['preferredLanguage', 'language']));
  const riskLevel = formatValue(findResourceValue(resourceJson, ['riskLevel', 'risk']));

  const wantsPhone = /\b(phone|telephone|number|contact|reach)\b/.test(text);
  const wantsEmail = /\b(email|e-mail|mail)\b/.test(text);
  const wantsName = /\b(name|full name|who am i|identity)\b/.test(text);
  const wantsBranch = /\b(primary branch|home branch|assigned branch|my branch)\b/.test(text) ||
    (/\bbranch\b/.test(text) && !/\bdirectory\b/.test(text));
  const wantsLanguage = /\b(language|langue|preferred language)\b/.test(text);
  const wantsSegment = /\b(segment|customer type|category)\b/.test(text);
  const wantsRisk = /\b(risk|risk level)\b/.test(text);

  if (wantsPhone && phone) return `Your profile phone is **${phone}**.`;
  if (wantsEmail && email) return `Your profile email is **${email}**.`;
  if (wantsName && fullName) return `Your name on file is **${fullName}**.`;
  if (wantsBranch && primaryBranch) return `Your primary branch is **${primaryBranch}**.`;
  if (wantsLanguage && preferredLanguage) return `Your preferred language is **${preferredLanguage}**.`;
  if (wantsSegment && segment) return `Your customer segment is **${segment}**.`;
  if (wantsRisk && riskLevel) return `Your risk level is **${riskLevel}**.`;

  const parts = [
    fullName && `name **${fullName}**`,
    segment && `segment **${segment}**`,
    phone && `phone **${phone}**`,
    primaryBranch && `primary branch **${primaryBranch}**`,
  ].filter(Boolean);
  if (!parts.length) return null;
  const title = formatValue(findResourceValue(resourceJson, ['title'])) || 'Customer Profile';
  return `Your **${title}**: ${parts.join(', ')}.`;
};

const buildMetadataFirstAnswer = ({ resourceJson = {}, message = '' } = {}) => {
  const enrichedResource = enrichResourceForAnswer(resourceJson);
  const resourceType = normalizeResourceType(enrichedResource.resourceType);
  const title = normalizeText(enrichedResource.title);

  if (
    title.includes('sms alert') ||
    normalizeText(findResourceValue(enrichedResource, ['channel', 'topic'])).includes('sms')
  ) {
    return buildSmsAlertAnswer(enrichedResource) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    title.includes('wire transfer') ||
    findResourceValue(enrichedResource, ['destinationCountry', 'feeEstimate'])
  ) {
    return buildWireTransferNoticeAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    title.includes('login error') ||
    title.includes('otp lock') ||
    findResourceValue(enrichedResource, ['errorCode'])
  ) {
    return buildAtbConnectLoginErrorAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    title.includes('direct debit mandate') ||
    findResourceValue(enrichedResource, ['mandateId'])
  ) {
    return buildDirectDebitMandateAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'beneficiary_profile' || title.includes('beneficiary profile')) {
    return buildBeneficiaryProfileAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    resourceType === 'business_account_checklist' ||
    resourceType === 'sme_document_checklist' ||
    title.includes('business account') ||
    title.includes('sme current account') ||
    title.includes('account opening checklist') ||
    title.includes('sme account opening') ||
    findResourceValue(enrichedResource, ['requiredDocuments', 'documentChecklist'])
  ) {
    return buildBusinessAccountChecklistAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'checkbook_request' || title.includes('checkbook request')) {
    return buildCheckbookRequestAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    resourceType === 'appointment_confirmation' ||
    resourceType === 'card_pickup_appointment' ||
    title.includes('appointment confirmation') ||
    title.includes('card pickup')
  ) {
    return buildAppointmentConfirmationAnswer(enrichedResource, message) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'card_limit_notice' || title.includes('credit card limit')) {
    // A question about one specific field ("available limit", "payment due", ...) is answered with
    // just that field; otherwise fall back to the full notice summary.
    return (
      buildSpecificCardFieldAnswer(message, enrichedResource) ||
      buildCardLimitAnswer(enrichedResource)
    );
  }

  if (resourceType === 'customer_profile' || title.includes('customer profile')) {
    return buildCustomerProfileAnswer(enrichedResource, message) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    resourceType === 'branch_directory' ||
    resourceType === 'branch_list' ||
    title.includes('branch directory')
  ) {
    return buildBranchDirectoryAnswer(enrichedResource, message) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'loan_offer' || title.includes('personal loan offer')) {
    return buildLoanOfferAnswer(enrichedResource);
  }

  if (
    resourceType === 'product_sheet' ||
    findResourceValue(enrichedResource, ['productName']) ||
    findResourceValue(enrichedResource, ['includes', 'includedServices', 'benefits'])
  ) {
    return buildProductSheetAnswer(enrichedResource) ||
      buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'savings_goal' || title.includes('savings goal')) {
    return buildSavingsGoalProgressAnswer(enrichedResource, message) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    resourceType === 'digital_banking_guide' ||
    resourceType === 'atb_connect_guide' ||
    title.includes('atb connect')
  ) {
    return buildAtbConnectAnswer(enrichedResource, message) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (resourceType === 'security_notice' || title.includes('security notice')) {
    return buildSecurityNoticeAnswer(enrichedResource) || buildGenericResourceAnswer(enrichedResource, message);
  }

  if (
    resourceType === 'bill_notice' ||
    resourceType === 'utility_bill' ||
    resourceType === 'bill_payment' ||
    title.includes('bill payment request') ||
    findResourceValue(enrichedResource, ['billReference'])
  ) {
    return buildBillPaymentRequestAnswer(enrichedResource, message);
  }

  return buildGenericResourceAnswer(enrichedResource, message);
};

const buildSpecificResourceAnswer = ({ resourceJson = {}, message = '' } = {}) => {
  const answer = buildMetadataFirstAnswer({ resourceJson, message });
  if (!answer) return { answer: null, isSpecific: false };
  const genericAnswer = buildGenericResourceAnswer(enrichResourceForAnswer(resourceJson), message);
  return { answer, isSpecific: answer !== genericAnswer };
};

const buildResourceFollowupAnswer = ({ message = '', resourceJson = {} } = {}) => {
  const text = normalizeText(message);
  const title = findResourceValue(resourceJson, ['title']) || 'the active resource';
  const resourceType = normalizeResourceType(resourceJson.resourceType);
  const normalizedTitle = normalizeText(title);
  const answer = (label, value, intro = null) => {
    const formatted = formatValue(value);
    if (!formatted) return null;
    return intro || `From **${title}**: **${label}:** ${formatted}`;
  };

  if (resourceType === 'card_limit_notice' || normalizedTitle.includes('credit card limit')) {
    if (/\bavailable\s+limit\b/.test(text)) {
      return answer('Available limit', findResourceValue(resourceJson, ['availableLimit']));
    }
    if (/\bcurrent\s+limit\b/.test(text)) {
      return answer('Current limit', findResourceValue(resourceJson, ['currentLimit']));
    }
    if (/\bpayment\s+due(?:\s+date)?\b/.test(text) || /\bdue\s+date\b/.test(text)) {
      const value = findResourceValue(resourceJson, ['paymentDueDate', 'dueDate']);
      const formatted = formatValue(value);
      return formatted
        ? `The payment due date on your **${title}** is **${formatted}**.`
        : null;
    }
    if (/\bminimum\s+payment\b/.test(text)) {
      return answer('Minimum payment', findResourceValue(resourceJson, ['minimumPayment']));
    }
    if (/\bstatement\s+date\b/.test(text)) {
      return answer('Statement date', findResourceValue(resourceJson, ['statementDate']));
    }
    if (/\b(card\s+number|masked\s+card)\b/.test(text) || /^(what|which)\s+(is\s+)?(the\s+)?card\b/.test(text)) {
      return answer('Card', findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber']));
    }
  }

  if (resourceType === 'loan_offer' || normalizedTitle.includes('personal loan offer')) {
    const durationMin = findResourceValue(resourceJson, ['minDurationMonths', 'durationMinMonths']);
    const durationMax = findResourceValue(resourceJson, ['maxDurationMonths', 'durationMaxMonths']);
    const duration = findResourceValue(resourceJson, ['duration', 'repaymentDuration']) ||
      (durationMin && durationMax ? `${durationMin} to ${durationMax} months` : null);

    if (/\bmaximum\s+amount\b/.test(text)) {
      return answer('Maximum amount', findResourceValue(resourceJson, ['maxAmount', 'maximumAmount', 'loanAmount', 'amount']));
    }
    if (/\bduration\b/.test(text)) {
      return answer('Duration', duration);
    }
    if (/\bmonthly\s+payment\b/.test(text)) {
      return answer('Monthly payment example', findResourceValue(resourceJson, ['monthlyPaymentExample', 'exampleMonthlyPayment', 'monthlyPayment']));
    }
    if (/\bestimated\s+rate\b/.test(text)) {
      return answer('Estimated rate', findResourceValue(resourceJson, ['estimatedRate', 'rate', 'interestRate']));
    }
    if (/\bpre\s+eligible\b|\bpreeligible\b/.test(text)) {
      return answer('Status', findResourceValue(resourceJson, ['status']));
    }
  }

  if (
    resourceType === 'bill_notice' ||
    resourceType === 'utility_bill' ||
    resourceType === 'bill_payment' ||
    normalizedTitle.includes('sonede') ||
    normalizedTitle.includes('bill payment')
  ) {
    if (/\bpaid\b|\bunpaid\b/.test(text)) {
      const status = findResourceValue(resourceJson, ['status']);
      const formatted = formatValue(status);
      return formatted
        ? `From **${title}**: the bill status is **${formatted}**.`
        : null;
    }
    if (/\bstatus\b/.test(text)) {
      return answer('Status', findResourceValue(resourceJson, ['status']));
    }
    if (/\bamount\b/.test(text)) {
      return answer('Amount', findResourceValue(resourceJson, ['amount', 'totalAmount', 'amountDue', 'total']));
    }
    if (/\bdue\s+date\b/.test(text)) {
      return answer('Due date', findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline']));
    }
    if (/\bbill\s+reference\b/.test(text)) {
      return answer('Bill reference', findResourceValue(resourceJson, ['billReference', 'billRef', 'invoiceReference', 'reference']));
    }
  }

  return null;
};

const parseAmountAndCurrency = (amountValue, currencyValue) => {
  if (amountValue === null || amountValue === undefined || amountValue === '') {
    return {
      amount: amountValue,
      currency: currencyValue || 'TND',
    };
  }

  if (typeof amountValue === 'number') {
    return {
      amount: amountValue,
      currency: currencyValue || 'TND',
    };
  }

  const text = String(amountValue || '').trim();
  const match = text.match(/(-?\d+(?:[.,]\d+)?)(?:\s*([A-Z]{3}))?/i);
  if (!match) {
    return {
      amount: amountValue,
      currency: currencyValue || 'TND',
    };
  }

  return {
    amount: match[1].replace(',', '.'),
    currency: currencyValue || match[2]?.toUpperCase() || 'TND',
  };
};

const extractBillPaymentFields = (resourceJson = {}) => {
  const amountValue = findResourceValue(resourceJson, ['amount', 'totalAmount', 'amountDue', 'total']);
  const currencyValue = findResourceValue(resourceJson, ['currency']);
  const parsedAmount = parseAmountAndCurrency(amountValue, currencyValue);

  return {
    provider: findResourceValue(resourceJson, ['provider', 'biller', 'merchant']),
    billReference: findResourceValue(resourceJson, [
      'billReference',
      'billRef',
      'invoiceReference',
      'reference',
    ]),
    amount: parsedAmount.amount,
    currency: parsedAmount.currency,
    dueDate: findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline']),
    status: findResourceValue(resourceJson, ['status']),
    sourceAccountId: findResourceValue(resourceJson, [
      'sourceAccountId',
      'accountId',
      'debitAccountId',
    ]),
  };
};

const isMetadataAnswerLikelyEnough = (message = '', resourceJson = {}) => {
  const text = normalizeText(message);
  const title = normalizeText(resourceJson.title);
  const resourceType = normalizeResourceType(resourceJson.resourceType);

  if (/\bpage\s+\d+\b/.test(text)) return false;
  if (resourceType === 'card_limit_notice' || title.includes('credit card limit')) return true;
  if (
    resourceType === 'digital_banking_guide' ||
    resourceType === 'atb_connect_guide' ||
    title.includes('atb connect')
  ) {
    return true;
  }
  if (
    resourceType === 'bill_notice' ||
    resourceType === 'utility_bill' ||
    resourceType === 'bill_payment' ||
    title.includes('bill payment request') ||
    findResourceValue(resourceJson, ['billReference'])
  ) {
    return true;
  }
  if (resourceType === 'loan_offer' || title.includes('personal loan offer')) {
    return (
      /\b(show|open|display|get|amount|duration|rate|monthly|payment|status|offer)\b/.test(text) &&
      !/\b(documents?|required documents?|papers?)\b/.test(text)
    );
  }

  return /\b(show|open|display|get)\b/.test(text);
};

const isGeneralBankingFallbackQuestion = (message = '') => {
  const text = normalizeText(message);
  const isQuestion = /^(what|how|why|when|where|can|do)\b/.test(text);
  const isLookupExplainable =
    /\b(show|open|get|find)\b/.test(text) &&
    /\b(rib|certificate|loan|credit|mobile banking|banking security|account|card|transfer|bill|payment|iban|overdraft)\b/.test(text);
  if (!isQuestion && !isLookupExplainable) return false;
  if (/\b(download|open|show|get|fetch)\b.*\b(document|pdf|file|form)\b/.test(text)) {
    return false;
  }
  if (/\bspaceship|fake|made up|nonexistent\b/.test(text)) return false;

  return /\b(rib|certificate|loan|credit|mobile banking|banking security|account|card|transfer|bill|payment|iban|overdraft)\b/.test(text);
};

const isGeneralBankingDefinitionQuestion = (message = '') => {
  const text = normalizeText(message);
  if (/\b(show|open|get|download|fetch|my|mine|documents?|pdf|file|form|resource|resources|status|required)\b/.test(text)) {
    return false;
  }

  return (
    /^(what\s+(?:is|are)|explain|how\s+(?:can\s+i|do\s+i|to)\s+protect)\b/.test(text) &&
    /\b(rib|certificate|loan|credit|mobile banking|banking security|account|card|transfer|bill|payment|iban|overdraft)\b/.test(text)
  );
};

const isCapabilitiesQuestion = (message = '') => {
  const text = normalizeText(message);
  return (
    /^(help|services|hello help|hi help|hey help)$/.test(text) ||
    /\bwhat\s+can\s+you\s+do\b/.test(text) ||
    /\bwhat\s+do\s+you\s+do\b/.test(text) ||
    /\bhow\s+can\s+you\s+help\b/.test(text) ||
    /\bhow\s+can\s+you\s+assist\b/.test(text) ||
    /\bwhat\s+can\s+you\s+help\s+(?:me\s+)?with\b/.test(text) ||
    /\bshow\s+me\s+your\s+(?:capabilities|services)\b/.test(text)
  );
};

const buildGeneralBankingFallbackAnswer = (message = '') => {
  const text = normalizeText(message);

  if (/\brib\b/.test(text) && /\bcertificate\b/.test(text)) {
    return (
      'A **RIB certificate** is a banking document that identifies a bank account. ' +
      'It usually contains the account holder name, bank details, branch or account information, ' +
      'and an account identifier such as a RIB or IBAN depending on the country.'
    );
  }

  if (/\bwhat\s+is\s+(?:a\s+|an\s+|the\s+)?loan\b/.test(text)) {
    return (
      'A **loan** is money a bank or lender provides that you agree to repay over time. ' +
      'You usually repay the borrowed amount plus interest and any fees, according to a schedule agreed in the loan contract.'
    );
  }

  if (/\bhow\b.*\bcredit\s+card\b.*\bwork\b/.test(text)) {
    return (
      'A **credit card** lets you spend up to an approved credit limit and repay the bank later. ' +
      'If you do not repay the full balance by the due date, interest and fees may apply.'
    );
  }

  if (/\blost\b.*\bcard\b|\bcard\b.*\blost\b/.test(text)) {
    return (
      'If you lost your card, block it immediately in your banking app or by contacting the bank, then request a replacement. ' +
      'Review recent transactions and report any payment you do not recognize.'
    );
  }

  if (/\bmobile banking security\b|\bbanking security\b/.test(text)) {
    return (
      '**Mobile banking security** means protecting access to your banking app and transactions. ' +
      'Use a strong password, keep OTP/SMS codes private, avoid suspicious links, and report unknown transactions quickly.'
    );
  }

  if (/\bavoid\b.*\b(mobile\s+banking\s+)?scams?\b|\bscams?\b.*\bmobile\s+banking\b/.test(text)) {
    return (
      'To avoid mobile banking scams, never share OTP or SMS codes, use only the official bank app or website, avoid suspicious links, ' +
      'check payment details before confirming, and contact the bank quickly if something looks unusual.'
    );
  }

  if (/\binterest\s+rates?\b/.test(text)) {
    return (
      'An **interest rate** is the price of borrowing money or the return paid on savings. ' +
      'For a loan, a higher rate usually means higher monthly payments and a higher total repayment cost.'
    );
  }

  if (/\bdocuments?\b.*\bneeded\b.*\bloan\b|\bdocuments?\b.*\brequired\b.*\bloan\b|\bloan\b.*\bdocuments?\b/.test(text)) {
    return (
      'For a loan, banks usually ask for identification, proof of income, recent bank statements, employment or business details, ' +
      'and documents related to the loan purpose. The exact list depends on the bank, loan type, and applicant profile.'
    );
  }

  if (/\bpersonal\s+loan\b|\bloan\b/.test(text)) {
    return (
      'A **personal loan** is credit granted to an individual for personal needs, usually repaid through fixed monthly installments. ' +
      'The main terms are the borrowed amount, repayment duration, interest rate, fees, monthly payment, and eligibility conditions.'
    );
  }

  if (/\beligib/.test(text) && /\bbanks?\b/.test(text)) {
    return (
      'Banks usually decide eligibility by reviewing income stability, existing debts, repayment history, account activity, requested amount, ' +
      'loan duration, and required documents. Final approval depends on the bank policy and risk checks.'
    );
  }

  if (/\bmiss\b.*\bbill\s+payment\b|\bbill\s+payment\b.*\bmiss\b/.test(text)) {
    return (
      'If you miss a bill payment, the provider may charge a late fee, restrict the service, or mark the bill as overdue. ' +
      'Pay it as soon as possible and contact the provider or bank if you need help.'
    );
  }

  if (/\bprepare\b.*\bbank\s+appointment\b|\bbank\s+appointment\b.*\bprepare\b/.test(text)) {
    return (
      'To prepare for a bank appointment, bring valid identification, relevant account or application references, proof of income if needed, ' +
      'and a short list of questions or documents you want reviewed.'
    );
  }

  if (/\bdifference\s+between\b.*\bdebit\s+card\b.*\bcredit\s+card\b/.test(text)) {
    return (
      'A **debit card** uses money from your bank account. A **credit card** uses a bank-approved credit limit that you repay later. ' +
      'Credit cards can involve interest and fees if the balance is not repaid on time.'
    );
  }

  return null;
};

const isGenericCapabilitiesResponse = (value = '') => {
  const text = normalizeText(value);
  return (
    text.includes('i can help with banking services') ||
    text.includes('i can assist you with banking services') ||
    (text.includes('accounts') && text.includes('transfers') && text.includes('documents') && text.includes('what can you do'))
  );
};

const buildFallbackAssistantMessage = ({
  originalAnswer,
  userMessage,
  resourceQuery,
} = {}) => {
  const fallbackAnswer = buildGeneralBankingFallbackAnswer(userMessage);
  const answer = (
    !originalAnswer ||
    isGenericCapabilitiesResponse(originalAnswer) ||
    (fallbackAnswer && !normalizeText(originalAnswer).includes(normalizeText(fallbackAnswer).slice(0, 20)))
  )
    ? fallbackAnswer || originalAnswer
    : originalAnswer;
  const resourceLabel = resourceQuery || userMessage;
  const note = `I did not find a matching **${resourceLabel}** document on the resource server, but I can explain it generally.`;

  return [answer, note].filter(Boolean).join('\n\n');
};

module.exports = {
  buildBranchDirectoryAnswer,
  buildBranchAnswerFromFacts,
  describeBranchMatch,
  extractBranchFacts,
  buildFallbackAssistantMessage,
  buildGeneralBankingFallbackAnswer,
  buildMetadataFirstAnswer,
  buildSpecificResourceAnswer,
  buildSpecificCardFieldAnswer,
  buildResourceFollowupAnswer,
  extractBillPaymentFields,
  findResourceValue,
  isCapabilitiesQuestion,
  isGeneralBankingDefinitionQuestion,
  isGeneralBankingFallbackQuestion,
  isGenericCapabilitiesResponse,
  isMetadataAnswerLikelyEnough,
  isAlreadyPaidOrReceiptResource,
};
