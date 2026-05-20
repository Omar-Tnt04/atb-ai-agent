function Button({
  as: Component = 'button',
  children,
  className = '',
  variant = 'primary',
  ...props
}) {
  return (
    <Component className={`button button-${variant} ${className}`.trim()} {...props}>
      {children}
    </Component>
  );
}

export default Button;
