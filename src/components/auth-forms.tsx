"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { demoAction, forgotPasswordAction, joinAction, loginAction, resetPasswordAction, signupAction } from "@/app/actions";
import { Button, Field, Input } from "./ui";

const zone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
};

function useSubmit() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, to = "/dashboard") => {
    setBusy(true);
    setError("");
    const r = await fn();
    if (!r.ok) {
      setBusy(false);
      setError(r.error);
      return;
    }
    router.push(to);
    router.refresh();
  };
  return { busy, error, submit };
}

export function SignupForm() {
  const { busy, error, submit } = useSubmit();
  const [form, setForm] = useState({ name: "", company: "", email: "", password: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(() => signupAction({ ...form, timeZone: zone() }));
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Your name">
          <Input required value={form.name} onChange={set("name")} autoComplete="name" maxLength={120} autoFocus />
        </Field>
        <Field label="Company">
          <Input required value={form.company} onChange={set("company")} autoComplete="organization" maxLength={120} />
        </Field>
      </div>
      <Field label="Work email">
        <Input required type="email" value={form.email} onChange={set("email")} autoComplete="email" maxLength={200} />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <Input required type="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={8} maxLength={200} />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Create workspace
      </Button>
      <p className="text-center text-sm text-muted">
        Already have one?{" "}
        <Link href="/login" className="font-semibold text-blue hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function LoginForm() {
  const { busy, error, submit } = useSubmit();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(() => loginAction({ email, password }));
      }}
    >
      <Field label="Email">
        <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
      </Field>
      <Field label="Password">
        <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
      </Field>
      <p className="-mt-2 text-right text-[13px]">
        <Link href="/forgot" className="font-semibold text-blue hover:underline">
          Forgot your password?
        </Link>
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Sign in
      </Button>
      <p className="text-center text-sm text-muted">
        New here?{" "}
        <Link href="/signup" className="font-semibold text-blue hover:underline">
          Create a workspace
        </Link>
      </p>
    </form>
  );
}

export function JoinForm({ token }: { token: string }) {
  const { busy, error, submit } = useSubmit();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(() => joinAction(token, form));
      }}
    >
      <Field label="Your name">
        <Input required value={form.name} onChange={set("name")} autoComplete="name" autoFocus />
      </Field>
      <Field label="Work email">
        <Input required type="email" value={form.email} onChange={set("email")} autoComplete="email" />
      </Field>
      <Field label="Password" hint="At least 8 characters.">
        <Input required type="password" value={form.password} onChange={set("password")} autoComplete="new-password" minLength={8} />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Join workspace
      </Button>
    </form>
  );
}

export function DemoButton({ variant = "secondary", size = "lg", className, children }: { variant?: "secondary" | "ghost" | "primary"; size?: "md" | "lg"; className?: string; children?: React.ReactNode }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        const r = await demoAction(zone());
        if (!r.ok) {
          setBusy(false);
          return void toast.error(r.error);
        }
        router.push("/dashboard");
        router.refresh();
      }}
    >
      {children ?? "Explore a sample workspace"}
    </Button>
  );
}

export function ForgotForm() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState<{ delivery: boolean } | null>(null);

  if (sent) {
    return sent.delivery ? (
      <div className="rounded-xl border border-line bg-surface p-5 text-[15px] text-ink-2">
        <p className="font-semibold text-ink">Check your inbox</p>
        <p className="mt-1">If an account exists for {email}, a link to choose a new password is on its way. It works once and expires in an hour.</p>
      </div>
    ) : (
      <div className="rounded-xl border border-amber/30 bg-amber-50 p-5 text-[15px] text-ink-2">
        <p className="font-semibold text-ink">Email is not set up on this deployment</p>
        <p className="mt-1">A reset link cannot be emailed here. Ask your workspace owner to create one for you under Settings, Team, and they can pass it to you directly.</p>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        const r = await forgotPasswordAction(email);
        setBusy(false);
        if (!r.ok) return void setError(r.error);
        setSent({ delivery: r.delivery });
      }}
    >
      <Field label="Email">
        <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Send reset link
      </Button>
      <p className="text-center text-sm text-muted">
        <Link href="/login" className="font-semibold text-blue hover:underline">
          Back to sign in
        </Link>
      </p>
    </form>
  );
}

export function ResetForm({ token }: { token: string }) {
  const { busy, error, submit } = useSubmit();
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(() => resetPasswordAction(token, { password }));
      }}
    >
      <Field label="New password" hint="At least 8 characters.">
        <Input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} autoFocus />
      </Field>
      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red">
          {error}
        </p>
      )}
      <Button type="submit" size="lg" className="w-full" loading={busy}>
        Save and sign in
      </Button>
    </form>
  );
}
