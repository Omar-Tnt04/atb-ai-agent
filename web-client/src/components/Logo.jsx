function Logo({ className = '', showText = false }) {
  return (
    <span className={`logo-lockup ${className}`.trim()}>
      <img src="/atb-logo.png" alt="ATB" className="logo-image" />
      {showText ? <span className="logo-title">ATB AI Banking Agent</span> : null}
    </span>
  );
}

export default Logo;
