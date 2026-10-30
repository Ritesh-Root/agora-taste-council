import { useEffect, useState, type FormEvent } from 'react';
import { fieldClass, primaryButton } from './ui';

export function PasscodeForm({ onUnlocked }: { onUnlocked: () => void }) {
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // A public demo publishes its passcode so judges can walk straight in.
  const [demoPasscode, setDemoPasscode] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/session')
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { demoPasscode?: unknown } | null) => {
        if (live && typeof body?.demoPasscode === 'string' && body.demoPasscode) setDemoPasscode(body.demoPasscode);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const unlock = async (value: string) => {
    setPending(true);
    setError(null);
    try {
      const response = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: value }),
      });
      if (!response.ok) {
        setError('That passcode is not right.');
        return;
      }
      onUnlocked();
    } catch {
      setError('The household could not be reached.');
    } finally {
      setPending(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void unlock(passcode);
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 id="home-passcode-title" className="text-base font-semibold text-ink text-balance">Unlock your household</h2>
      {demoPasscode ? (
        <div className="space-y-2 rounded-2xl bg-white/70 p-3 text-sm text-ink">
          <p>
            This is a public demo with a fictional family. The passcode is{' '}
            <code className="rounded bg-black/5 px-1.5 py-0.5 font-mono">{demoPasscode}</code>.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setPasscode(demoPasscode);
              void unlock(demoPasscode);
            }}
            className={`${primaryButton} w-full`}
          >
            Enter the demo
          </button>
        </div>
      ) : null}
      <label htmlFor="home-passcode" className="block text-sm text-ink">Household passcode</label>
      <input
        id="home-passcode"
        type="password"
        autoComplete="off"
        autoFocus={!demoPasscode}
        value={passcode}
        onChange={(event) => setPasscode(event.target.value)}
        className={`${fieldClass} w-full`}
      />
      {error ? <p className="text-sm text-ink">{error}</p> : null}
      <button type="submit" disabled={pending || !passcode} className={`${primaryButton} w-full`}>
        Unlock
      </button>
    </form>
  );
}
