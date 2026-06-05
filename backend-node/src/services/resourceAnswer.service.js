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

const buildAtbConnectAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'ATB Connect Activation Guide';
  const activationChannel = findResourceValue(resourceJson, ['activationChannel', 'channel']);
  const requiredId = findResourceValue(resourceJson, ['requiredId', 'requiredID', 'requiredDocument']);
  const steps = findResourceValue(resourceJson, ['steps', 'activationSteps', 'setupSteps']);
  const support = findResourceValue(resourceJson, ['supportChannel', 'support']);

  const stepText = Array.isArray(steps)
    ? steps.map((step) => formatValue(step)).filter(Boolean).join(', ')
    : formatValue(steps);
  const parts = [
    `The **${title}** says activation can be done${activationChannel ? ` through **${formatValue(activationChannel)}**` : ''}.`,
    requiredId ? `You need **${formatValue(requiredId)}**.` : null,
    stepText ? `The steps are: ${stepText}.` : null,
    support ? `For help, use **${formatValue(support)}**.` : null,
  ].filter(Boolean);

  return parts.length ? parts.join(' ') : null;
};

const buildCardLimitAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'Credit Card Limit Notice';
  const rows = [
    row('Card', findResourceValue(resourceJson, ['card', 'maskedCard', 'cardNumber'])),
    row('Current limit', findResourceValue(resourceJson, ['currentLimit'])),
    row('Available limit', findResourceValue(resourceJson, ['availableLimit'])),
    row('Statement date', findResourceValue(resourceJson, ['statementDate'])),
    row('Payment due date', findResourceValue(resourceJson, ['paymentDueDate', 'dueDate'])),
    row('Minimum payment', findResourceValue(resourceJson, ['minimumPayment'])),
  ].filter(Boolean);

  return rows.length
    ? [`I found your **${title}**.`, '', ...rows].join('\n')
    : null;
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

const buildBillPaymentRequestAnswer = (resourceJson = {}) => {
  const provider = findResourceValue(resourceJson, ['provider', 'biller', 'merchant']);
  const title = findResourceValue(resourceJson, ['title']) || `${provider || 'Bill'} Payment Request`;
  const rows = [
    row('Provider', provider),
    row('Bill reference', findResourceValue(resourceJson, ['billReference', 'billRef', 'invoiceReference', 'reference'])),
    row('Amount', findResourceValue(resourceJson, ['amount', 'totalAmount', 'amountDue', 'total'])),
    row('Due date', findResourceValue(resourceJson, ['dueDate', 'paymentDueDate', 'deadline'])),
    row('Status', findResourceValue(resourceJson, ['status'])),
  ].filter(Boolean);

  return rows.length
    ? [`I found the **${title}**.`, '', ...rows].join('\n')
    : null;
};

const buildGenericResourceAnswer = (resourceJson = {}) => {
  const title = findResourceValue(resourceJson, ['title']) || 'resource';
  const rows = [
    row('Summary', findResourceValue(resourceJson, ['summary', 'description', 'purpose'])),
    row('Category', findResourceValue(resourceJson, ['category', 'resourceType'])),
    row('Status', findResourceValue(resourceJson, ['status'])),
    row('Language', findResourceValue(resourceJson, ['language'])),
  ].filter(Boolean);

  return rows.length
    ? [`I found **${title}**.`, '', ...rows].join('\n')
    : `I found **${title}**.`;
};

const buildMetadataFirstAnswer = ({ resourceJson = {} } = {}) => {
  const resourceType = normalizeResourceType(resourceJson.resourceType);
  const title = normalizeText(resourceJson.title);

  if (resourceType === 'card_limit_notice' || title.includes('credit card limit')) {
    return buildCardLimitAnswer(resourceJson);
  }

  if (resourceType === 'loan_offer' || title.includes('personal loan offer')) {
    return buildLoanOfferAnswer(resourceJson);
  }

  if (
    resourceType === 'digital_banking_guide' ||
    resourceType === 'atb_connect_guide' ||
    title.includes('atb connect')
  ) {
    return buildAtbConnectAnswer(resourceJson) || buildGenericResourceAnswer(resourceJson);
  }

  if (
    resourceType === 'bill_notice' ||
    resourceType === 'utility_bill' ||
    resourceType === 'bill_payment' ||
    title.includes('bill payment request') ||
    findResourceValue(resourceJson, ['billReference'])
  ) {
    return buildBillPaymentRequestAnswer(resourceJson);
  }

  return buildGenericResourceAnswer(resourceJson);
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
  buildFallbackAssistantMessage,
  buildGeneralBankingFallbackAnswer,
  buildMetadataFirstAnswer,
  buildResourceFollowupAnswer,
  extractBillPaymentFields,
  findResourceValue,
  isCapabilitiesQuestion,
  isGeneralBankingDefinitionQuestion,
  isGeneralBankingFallbackQuestion,
  isGenericCapabilitiesResponse,
  isMetadataAnswerLikelyEnough,
};
