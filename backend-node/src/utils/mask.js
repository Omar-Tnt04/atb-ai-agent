const maskAccountNumber = (accountNumber) => {
  if (!accountNumber) {
    return null;
  }

  return `********${accountNumber.slice(-4)}`;
};

const maskPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) {
    return null;
  }

  return `********${phoneNumber.slice(-3)}`;
};

const maskRib = (rib) => {
  if (!rib) {
    return null;
  }

  return `********${rib.slice(-4)}`;
};

module.exports = {
  maskAccountNumber,
  maskPhoneNumber,
  maskRib,
};
