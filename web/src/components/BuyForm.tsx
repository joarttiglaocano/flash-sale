import { useState, type FormEvent } from 'react';

const USER_ID_PATTERN = /^[a-z0-9._@+-]{1,64}$/i;

interface Props {
  userId: string;
  onUserIdChange: (value: string) => void;
  onSubmit: (normalized: string) => void;
  busy: boolean;
  disabled: boolean;
}

export function BuyForm({ userId, onUserIdChange, onSubmit, busy, disabled }: Props) {
  const [fieldError, setFieldError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const normalized = userId.trim().toLowerCase();
    if (!USER_ID_PATTERN.test(normalized)) {
      setFieldError(
        'Use letters, numbers, or a valid email — max 64 characters',
      );
      return;
    }
    setFieldError(null);
    onSubmit(normalized);
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      <label
        htmlFor="userId"
        className="mb-1.5 block text-xs text-neutral-400"
      >
        Your email or username
      </label>
      <input
        id="userId"
        name="userId"
        type="text"
        autoComplete="username"
        placeholder="you@example.com"
        value={userId}
        onChange={(e) => {
          onUserIdChange(e.target.value);
          if (fieldError) setFieldError(null);
        }}
        aria-invalid={fieldError !== null}
        aria-describedby={fieldError ? 'userId-error' : undefined}
        className={`mb-1 w-full rounded-lg border bg-neutral-900 px-3 py-2.5 text-sm text-neutral-200 outline-none transition placeholder:text-neutral-600 focus:border-teal-400/60 ${
          fieldError ? 'border-red-400' : 'border-neutral-800'
        }`}
      />
      {fieldError && (
        <p id="userId-error" className="mb-2 text-xs text-red-300">
          {fieldError}
        </p>
      )}
      <button
        type="submit"
        disabled={busy || disabled}
        className="mt-2 w-full rounded-lg bg-teal-400 py-3 text-[15px] font-medium text-teal-950 transition enabled:hover:bg-teal-300 disabled:cursor-not-allowed disabled:bg-teal-900 disabled:text-teal-200/50"
      >
        {busy ? 'Securing your item…' : 'Buy now'}
      </button>
    </form>
  );
}
