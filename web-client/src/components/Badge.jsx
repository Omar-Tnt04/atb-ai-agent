function Badge({ children, className = '', tone = 'neutral' }) {
  return (
    <span className={`badge badge-${tone} ${className}`.trim()}>{children}</span>
  );
}

export default Badge;
