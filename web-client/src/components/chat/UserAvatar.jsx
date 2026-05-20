const getInitials = (name = '') => {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    return 'U';
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
};

function UserAvatar({ profile, user }) {
  const displayName = profile?.fullName?.trim() || user?.fullName;

  return <span className="user-avatar" aria-label="Current user">{getInitials(displayName)}</span>;
}

export default UserAvatar;
