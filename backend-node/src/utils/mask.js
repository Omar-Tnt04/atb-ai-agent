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

module.exports = {
  maskAccountNumber,
  maskPhoneNumber,
};
