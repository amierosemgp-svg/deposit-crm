"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Send, Wallet } from "lucide-react";

/**
 * Sign-in, in one or two steps.
 *
 * An account with two-factor off finishes on the password, exactly as before.
 * One with it on gets no session from /login — just a challenge id — and the
 * code it's waiting for arrives on Telegram.
 */

type Challenge = {
  challenge_id: number;
  expires_at: string;
  telegram_hint: string;
};

/** "4:38" — a countdown reads better than an absolute expiry time. */
function useCountdown(until: string | undefined): string | null {
  const [left, setLeft] = useState<number>(0);
  useEffect(() => {
    if (!until) return;
    const tick = () => setLeft(Math.max(0, new Date(until).getTime() - Date.now()));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until]);
  if (!until) return null;
  const secs = Math.ceil(left / 1000);
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState("");
  const [resending, setResending] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const countdown = useCountdown(challenge?.expires_at);

  // The code field is the only thing to do on this step — put the caret in it.
  useEffect(() => {
    if (challenge) codeRef.current?.focus();
  }, [challenge]);

  function done() {
    // The workbook is where the day starts.
    router.push("/transactions");
    router.refresh();
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Login failed");
        setLoading(false);
        return;
      }
      if (body?.two_factor_required) {
        setChallenge({
          challenge_id: body.challenge_id,
          expires_at: body.expires_at,
          telegram_hint: body.telegram_hint ?? "your linked Telegram",
        });
        setLoading(false);
        return;
      }
      done();
    } catch {
      setError("Network error — please try again");
      setLoading(false);
    }
  }

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!challenge) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/verify-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.challenge_id, code }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "That code didn't work");
        setCode("");
        // A dead challenge can't be retried — back to the password.
        if (body?.retryable === false) setChallenge(null);
        setLoading(false);
        return;
      }
      done();
    } catch {
      setError("Network error — please try again");
      setLoading(false);
    }
  }

  async function onResend() {
    if (!challenge || resending) return;
    setResending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/resend-2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ challenge_id: challenge.challenge_id }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        setError(body?.error ?? "Couldn't send another code");
        return;
      }
      setChallenge({ ...challenge, challenge_id: body.challenge_id, expires_at: body.expires_at });
      setCode("");
      codeRef.current?.focus();
    } catch {
      setError("Network error — please try again");
    } finally {
      setResending(false);
    }
  }

  function backToPassword() {
    setChallenge(null);
    setCode("");
    setError(null);
    setPassword("");
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-background via-background to-muted px-4">
      <Card className="w-full max-w-[400px] shadow-lg">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            {challenge ? <Send className="h-5 w-5" /> : <Wallet className="h-6 w-6" />}
          </div>
          <CardTitle className="text-xl">
            {challenge ? "Check Telegram" : "Players Console"}
          </CardTitle>
          <CardDescription>
            {challenge ? (
              <>
                We sent a 6-digit code to{" "}
                <span className="font-medium text-foreground">{challenge.telegram_hint}</span>
              </>
            ) : (
              "MPG Unified Deposit & Withdrawal Platform"
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {challenge ? (
            <form className="space-y-4" onSubmit={onVerify}>
              <div className="space-y-2">
                <Label htmlFor="code">Sign-in code</Label>
                <Input
                  id="code"
                  ref={codeRef}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  className="h-12 text-center text-2xl font-semibold tracking-[0.4em] tabular-nums"
                />
                <p className="text-center text-xs text-muted-foreground">
                  {countdown && countdown !== "0:00"
                    ? `Expires in ${countdown}`
                    : "This code has expired — send another"}
                </p>
              </div>
              {error && (
                <p className="text-sm text-destructive text-center" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                className="w-full h-10 cursor-pointer"
                disabled={loading || code.length < 6}
              >
                {loading ? "Checking…" : "Verify & sign in"}
              </Button>
              <div className="flex items-center justify-between text-sm">
                <button
                  type="button"
                  onClick={backToPassword}
                  className="inline-flex cursor-pointer items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Back
                </button>
                <button
                  type="button"
                  onClick={onResend}
                  disabled={resending}
                  className="cursor-pointer text-primary hover:underline disabled:opacity-60"
                >
                  {resending ? "Sending…" : "Send another code"}
                </button>
              </div>
            </form>
          ) : (
            <form className="space-y-4" onSubmit={onSubmit}>
              <div className="space-y-2">
                <Label htmlFor="username">Username / Email</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="flex items-center justify-between text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-4 w-4 rounded border-border accent-primary"
                  />
                  Remember me
                </label>
                <a href="#" className="text-primary hover:underline">
                  Forgot password?
                </a>
              </div>
              {error && (
                <p className="text-sm text-destructive text-center" role="alert">
                  {error}
                </p>
              )}
              <Button type="submit" className="w-full h-10 cursor-pointer" disabled={loading}>
                {loading ? "Signing in…" : "Login"}
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
