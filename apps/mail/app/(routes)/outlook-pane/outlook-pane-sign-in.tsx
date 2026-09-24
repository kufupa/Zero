import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/auth-client';
import { Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export function OutlookPaneSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    try {
      const result = await signIn.email({
        email,
        password,
        callbackURL: '/outlook-pane',
      });
      if (result.error) {
        toast.error(result.error.message || 'Login failed');
        return;
      }
      toast.success('Signed in');
      window.location.assign('/outlook-pane');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen w-full flex-col justify-center bg-slate-950 p-4 text-slate-100">
      <div className="mb-4 text-center">
        <h1 className="flex items-center justify-center gap-2 text-lg font-bold text-white">
          <Sparkles className="h-4 w-4 text-amber-400" />
          Nava Assistant Sign In
        </h1>
        <p className="text-xs text-slate-400">Sign in once with your hotel staff account to activate.</p>
      </div>
      <form className="space-y-3" onSubmit={onSubmit}>
        <Input
          type="email"
          name="email"
          autoComplete="username"
          placeholder="Email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          required
        />
        <Input
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          minLength={6}
          required
        />
        <Button type="submit" className="w-full" disabled={submitting}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
