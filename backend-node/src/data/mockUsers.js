const mockUsers = [
  {
    id: 'user_client_001',
    fullName: 'Ahmed Ben Ali',
    email: 'client@atb.com',
    password: 'client123',
    role: 'CLIENT',
    phoneNumber: '+21655123456',
    phoneVerified: true,
  },
  {
    id: 'user_employee_001',
    fullName: 'Sarra Trabelsi',
    email: 'employee@atb.com',
    password: 'employee123',
    role: 'SUPPORT_AGENT',
    phoneNumber: '+21655999888',
    phoneVerified: true,
  },
  {
    id: 'user_admin_001',
    fullName: 'Admin ATB',
    email: 'admin@atb.com',
    password: 'admin123',
    role: 'ADMIN',
    phoneNumber: null,
    phoneVerified: false,
  },
];

module.exports = mockUsers;
