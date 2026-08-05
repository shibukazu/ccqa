import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { LoginSchema } from "../../../shared/auth";
import { login } from "../api/auth";
import { ApiError } from "../api/http";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";

export function LoginPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = LoginSchema.safeParse({ email, password });
    if (!parsed.success) {
      setError("Enter a valid email and password");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await login(parsed.data);
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong, try again");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-card">
      <h1>Sign in</h1>
      <form onSubmit={handleSubmit} noValidate>
        <TextField
          id="email"
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          id="password"
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button type="submit" disabled={submitting}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
