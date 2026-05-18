const mockUsers = require('../data/mockUsers');
const { generateToken } = require('../utils/token');

const maskPhoneNumber = (phoneNumber) => {
  if (!phoneNumber) {
    return null;
  }

  return `********${phoneNumber.slice(-3)}`;
};

const toSafeUser = (user) => {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    phoneNumber: maskPhoneNumber(user.phoneNumber),
    phoneVerified: user.phoneVerified,
  };
};

const login = (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      success: false,
      message: 'Email and password are required',
    });
  }

  const user = mockUsers.find(
    (mockUser) => mockUser.email === email && mockUser.password === password,
  );

  if (!user) {
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password',
    });
  }

  return res.json({
    success: true,
    message: 'Login successful',
    token: generateToken(user),
    user: toSafeUser(user),
  });
};

const getMe = (req, res) => {
  return res.json({
    success: true,
    user: toSafeUser(req.user),
  });
};

module.exports = {
  login,
  getMe,
};
