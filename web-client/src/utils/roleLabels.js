export const isAdminRole = (role) => role === 'ADMIN';

export const getDisplayRole = (role) => {
  if (isAdminRole(role)) {
    return 'ADMIN';
  }

  return 'USER';
};

export const getRoleHomePath = (role) => (isAdminRole(role) ? '/dashboard' : '/chat');
