const normalizeText = (value = '') =>
  String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const tokenSet = (value = '') =>
  new Set(normalizeText(value).split(/\s+/).filter((token) => token.length >= 2));

const RESOURCE_ALIASES = [
  {
    title: 'Customer Profile Overview',
    aliases: ['customer profile', 'my profile', 'client profile', 'customer overview', 'user profile'],
  },
  {
    title: 'ATB Branch Directory - Tunis Region',
    aliases: ['branch directory', 'branches in Tunis', 'Tunis branches', 'nearest branch', 'opening hours', 'branch location'],
  },
  {
    title: 'ATB Connect Activation Guide',
    aliases: ['ATB Connect', 'activate ATB Connect', 'online banking activation', 'mobile banking activation', 'activation guide', 'digital banking activation'],
  },
  {
    title: 'Mobile Banking Security Notice',
    aliases: ['security notice', 'mobile banking security', 'OTP advice', 'avoid sharing OTP', 'banking security', 'suspicious transactions'],
  },
  {
    title: 'Credit Card Limit Notice',
    aliases: ['credit card limit', 'card limit notice', 'available card limit', 'payment due date', 'minimum payment', 'card 1122'],
  },
  {
    title: 'Standing Order - Monthly Rent',
    aliases: ['standing order', 'rent order', 'monthly rent', 'next rent payment', 'recurring payment'],
  },
  {
    title: 'International Transfer Request',
    aliases: ['international transfer', 'transfer to France', 'Sami Tentouch', 'EUR transfer', 'pending international transfer'],
  },
  {
    title: 'Debit Card Replacement Request',
    aliases: ['debit card replacement', 'lost card', 'replace my card', 'replacement fee', 'card 9011'],
  },
  {
    title: 'Online Purchase Dispute',
    aliases: ['online dispute', 'Amazon dispute', 'purchase dispute', 'card dispute', 'waiting for documents'],
  },
  {
    title: 'Personal Loan Offer - Student Pack',
    aliases: ['personal loan', 'student loan', 'student personal loan', 'loan offer', 'student pack loan', 'loan amount', 'loan duration', 'monthly payment'],
  },
  {
    title: 'SME Current Account Product Sheet',
    aliases: ['SME account', 'business current account', 'small business account', 'SME product'],
  },
  {
    title: 'Student Pack Product Sheet',
    aliases: ['student pack', 'student banking', 'student product', 'student account', 'student debit card'],
  },
  {
    title: 'ATM Cash Withdrawal Receipt',
    aliases: ['ATM receipt', 'cash withdrawal receipt', 'ATM withdrawal', 'withdrawal 200'],
  },
  {
    title: 'STEG Bill Payment Receipt',
    aliases: ['STEG receipt', 'STEG payment', 'STEG bill paid', 'electricity payment receipt'],
  },
  {
    title: 'SONEDE Bill Payment Request',
    aliases: ['SONEDE bill', 'SONEDE payment', 'water bill', 'pay my SONEDE bill', 'SONEDE unpaid bill'],
  },
  {
    title: 'Telecom Bill Payment Request',
    aliases: ['telecom bill', 'Tunisie Telecom bill', 'phone bill', 'pay telecom bill'],
  },
  {
    title: 'Salary Domiciliation Certificate',
    aliases: ['salary domiciliation', 'salary certificate', 'domiciliation certificate', 'employer certificate'],
  },
  {
    title: 'Tax Residency Self-Certification',
    aliases: ['tax residency', 'self certification', 'tax form', 'KYC tax', 'signature pending'],
  },
  {
    title: 'Home Insurance Policy Summary',
    aliases: ['home insurance', 'insurance policy', 'home policy', 'annual premium', 'policy summary'],
  },
  {
    title: 'Foreign Currency Exchange Receipt',
    aliases: ['exchange receipt', 'currency exchange', 'EUR exchange', 'TND to EUR', 'exchange rate'],
  },
].map((item) => ({
  ...item,
  normalizedTitle: normalizeText(item.title),
  normalizedAliases: item.aliases.map(normalizeText),
}));

const scoreAliasPhrase = (messageText, aliasText) => {
  if (!messageText || !aliasText) return 0;
  if (messageText === aliasText) return 120;
  if (messageText.includes(aliasText)) return 100;

  const messageTokens = tokenSet(messageText);
  const aliasTokens = Array.from(tokenSet(aliasText));
  if (!aliasTokens.length) return 0;

  const matched = aliasTokens.filter((token) => messageTokens.has(token)).length;
  const ratio = matched / aliasTokens.length;
  return ratio >= 0.75 ? Math.round(60 * ratio) : 0;
};

const scoreAliasForTitle = (message, title = '') => {
  const messageText = normalizeText(message);
  const titleText = normalizeText(title);
  if (!messageText || !titleText) {
    return { score: 0, matchedTitle: null, matchedAlias: null };
  }

  let best = { score: scoreAliasPhrase(messageText, titleText), matchedTitle: title, matchedAlias: title };

  for (const resource of RESOURCE_ALIASES) {
    const titleMatches =
      resource.normalizedTitle === titleText ||
      resource.normalizedTitle.includes(titleText) ||
      titleText.includes(resource.normalizedTitle);
    if (!titleMatches) continue;

    for (const alias of resource.normalizedAliases) {
      const score = scoreAliasPhrase(messageText, alias);
      if (score > best.score) {
        best = {
          score,
          matchedTitle: resource.title,
          matchedAlias: alias,
        };
      }
    }
  }

  return best;
};

const matchResourceAlias = (message = '') => {
  const messageText = normalizeText(message);
  let best = null;

  for (const resource of RESOURCE_ALIASES) {
    const candidates = [resource.normalizedTitle, ...resource.normalizedAliases];
    for (const alias of candidates) {
      const score = scoreAliasPhrase(messageText, alias);
      if (score > 0 && (!best || score > best.score)) {
        best = {
          title: resource.title,
          alias,
          score,
        };
      }
    }
  }

  return best;
};

const findAliasMatchesInCatalog = (message = '', catalog = []) => {
  return catalog
    .map((entry) => {
      const alias = scoreAliasForTitle(message, entry.metadata?.title || entry.fileName || '');
      return {
        ...entry,
        aliasScore: alias.score,
        aliasMatchedTitle: alias.matchedTitle,
        aliasMatchedAlias: alias.matchedAlias,
      };
    })
    .filter((entry) => entry.aliasScore > 0)
    .sort((a, b) => b.aliasScore - a.aliasScore);
};

module.exports = {
  RESOURCE_ALIASES,
  findAliasMatchesInCatalog,
  matchResourceAlias,
  normalizeAliasText: normalizeText,
  scoreAliasForTitle,
};
