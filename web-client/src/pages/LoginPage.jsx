function LoginPage() {
  return (
    <section className="narrow-page">
      <div className="form-panel">
        <p className="eyebrow">Secure Access</p>
        <h1>Customer login</h1>
        <form className="login-form">
          <label>
            Email address
            <input type="email" placeholder="customer@example.com" disabled />
          </label>

          <label>
            Password
            <input type="password" placeholder="Password" disabled />
          </label>

          <button type="button" className="primary-button" disabled>
            Login unavailable
          </button>
        </form>
      </div>
    </section>
  );
}

export default LoginPage;
