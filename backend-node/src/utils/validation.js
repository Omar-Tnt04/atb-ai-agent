const getMissingFields = (requiredFields = [], payload = {}) => {
  return requiredFields.filter((field) => {
    const value = payload[field];

    return (
      value === undefined ||
      value === null ||
      (typeof value === 'string' && value.trim() === '')
    );
  });
};

module.exports = {
  getMissingFields,
};
