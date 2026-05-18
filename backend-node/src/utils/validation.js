const getMissingFields = (requiredFields = [], payload = {}) => {
  return requiredFields.filter((field) => {
    const value = payload[field];

    return value === undefined || value === null || value === '';
  });
};

module.exports = {
  getMissingFields,
};
