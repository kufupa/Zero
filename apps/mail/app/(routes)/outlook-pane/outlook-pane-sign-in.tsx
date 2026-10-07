import { Eye, EyeOff, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { signIn } from '@/lib/auth-client';
import { useState } from 'react';
import { toast } from 'sonner';

const inputClassName =
  'border-[#cbd5e1] bg-white text-[#1e293b] placeholder:text-[#94a3b8] focus-visible:ring-[#1a4332] focus-visible:ring-offset-white';

export function OutlookPaneSignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
    <div className="flex min-h-screen w-full flex-col justify-center bg-[#f1f3f6] p-4 font-['Segoe_UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif] text-[#1e293b] [color-scheme:light]">
      <div className="rounded-lg border border-[#e2e8f0] bg-white p-4 shadow-sm">
        <div className="mb-4 text-center">
          <h1 className="flex items-center justify-center gap-2 text-lg font-bold text-[#1e293b]">
            <Sparkles className="h-4 w-4 text-[#1a4332]" />
            Nava Assistant Sign In
          </h1>
          <p className="text-xs text-[#64748b]">
            Sign in once with your hotel staff account to activate.
          </p>
        </div>
        <form className="space-y-3" onSubmit={onSubmit}>
          <Input
            type="email"
            name="email"
            autoComplete="username"
            placeholder="Email"
            className={inputClassName}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          <div className="relative">
            <Input
              type={showPassword ? 'text' : 'password'}
              name="password"
              autoComplete="current-password"
              placeholder="Password"
              className={`${inputClassName} pr-10 [&::-ms-reveal]:hidden`}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              minLength={6}
              required
            />
            <button
              type="button"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              onClick={() => setShowPassword((visible) => !visible)}
              className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-md text-[#64748b] hover:text-[#1e293b] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a4332]"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
          <Button
            type="submit"
            className="w-full bg-[#1a4332] text-white hover:bg-[#123023]"
            disabled={submitting}
          >
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
