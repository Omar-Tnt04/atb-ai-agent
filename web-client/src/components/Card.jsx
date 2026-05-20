function Card({ children, className = '', as: Component = 'div', ...props }) {
  return (
    <Component className={`card ${className}`.trim()} {...props}>
      {children}
    </Component>
  );
}

export default Card;
