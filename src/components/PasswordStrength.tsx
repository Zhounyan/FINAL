import { forwardRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Check, Eye, EyeOff, X } from 'lucide-react';
import { assessPassword, STRENGTH_LABELS } from '@shared/password-policy';
import { Field } from './ui/Field';

type Props = InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; error?: string; hint?: ReactNode };

export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput(
  { label, error, hint, required, className, ...rest },
  ref,
) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      {(id, describedBy) => (
        <div className="relative">
          <input
            ref={ref}
            id={id}
            type={visible ? 'text' : 'password'}
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            required={required}
            maxLength={72}
            className={clsx('input pr-10', error && 'input-invalid', className)}
            {...rest}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1.5 text-slate-400 hover:text-brand-800"
            aria-label={visible ? 'Hide password' : 'Show password'}
            tabIndex={-1}
          >
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      )}
    </Field>
  );
});

const BAR_COLORS = ['bg-red-600', 'bg-orange-500', 'bg-amber-400', 'bg-lime-500', 'bg-emerald-600', 'bg-brand-800'];
const TEXT_COLORS = ['text-red-700', 'text-orange-600', 'text-amber-700', 'text-lime-700', 'text-emerald-700', 'text-brand-800'];

/** Real-time strength meter: Poor → Weak → Fair → Good → Strong → Super Strong. */
export function PasswordStrengthMeter({ password }: { password: string }) {
  const a = assessPassword(password);
  const empty = password.length === 0;
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-brand-50/40 p-3" data-testid="password-meter">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-muted">Password strength</span>
        <span className={clsx('font-semibold', empty ? 'text-slate-400' : TEXT_COLORS[a.score])} aria-live="polite" data-testid="strength-label">
          {empty ? '—' : a.label}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-1" aria-hidden>
        {STRENGTH_LABELS.map((l, i) => (
          <div key={l} className={clsx('h-1.5 rounded-full transition-colors duration-300', !empty && i <= a.score ? BAR_COLORS[a.score] : 'bg-slate-200')} />
        ))}
      </div>
      <ul className="grid gap-1 text-xs sm:grid-cols-2">
        {a.requirements.map((r) => (
          <li key={r.id} className={clsx('flex items-center gap-1.5', r.met ? 'text-emerald-700' : 'text-muted')} data-met={r.met}>
            {r.met ? <Check className="size-3.5 shrink-0" /> : <X className="size-3.5 shrink-0 text-slate-400" />}
            {r.label}
          </li>
        ))}
      </ul>
      {!empty && a.warnings.length > 0 && <p className="text-xs text-amber-700">{a.warnings[0]}</p>}
    </div>
  );
}
