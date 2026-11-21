import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { activateSharedDisplay } from "@/lib/shared-production-display";
import { Delete, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearTrustedStaffDevice,
  activateTrustedStaffDevice,
  readTrustedStaffDevice,
  signInWithStaffPin,
} from "@/lib/staff-pin-login";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function StaffPinSignIn() {
  const [device, setDevice] = useState(() =>
    readTrustedStaffDevice(),
  );
  const [pin, setPin] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [activating, setActivating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(
    null,
  );

  function appendDigit(digit: string) {
    setFormError(null);
    setPin((current) =>
      current.length < 6 ? `${current}${digit}` : current,
    );
  }

  function deleteDigit() {
    setFormError(null);
    setPin((current) => current.slice(0, -1));
  }

  function forgetDevice() {
    clearTrustedStaffDevice();
    setDevice(null);
    setPin("");
    setFormError(null);
  }

  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    setFormError(null);

    if (pin.length !== 6) {
      setFormError("Enter your six-digit personal PIN.");
      return;
    }

    setBusy(true);

    try {
      const { branchId } = await signInWithStaffPin(pin);

      setPin("");
      toast.success("Signed in");

      window.location.replace(
        `/workspace?home=1&property=${encodeURIComponent(branchId)}`,
      );
    } catch (error) {
      setPin("");
      setDevice(readTrustedStaffDevice());
      setFormError(
        error instanceof Error
          ? error.message
          : "PIN not accepted. Check your PIN or ask your supervisor.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function activateDevice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    setBusy(true);
    try {
      if (/^neods_[0-9a-f]{32}$/i.test(activationCode)) {
        await activateSharedDisplay(activationCode);
        setActivationCode("");
        return;
      }
      const activated = await activateTrustedStaffDevice(activationCode);
      setDevice(activated);
      setActivating(false);
      setActivationCode("");
      toast.success(`Device authorised for ${activated.propertyName}`);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "This device could not be activated.");
    } finally {
      setBusy(false);
    }
  }

  if (!device || activating) {
    return (
      <section
        data-neo-staff-pin-login
        className="space-y-5"
      >
        <div className="rounded-2xl border border-neo-mist bg-neo-cloud/60 p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-neo-mist text-neo-steel">
              <KeyRound className="size-5" aria-hidden />
            </span>

            <div className="space-y-2">
              <h2 className="font-semibold text-neo-midnight">
                {device ? "Activate a station display" : "This device is not yet authorised"}
              </h2>

              <p className="text-sm leading-relaxed text-neo-steel">
                Ask your administrator for a one-use activation code for this device.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={activateDevice} className="space-y-3">
          <label htmlFor="staff-device-activation" className="text-sm font-semibold">Device activation code</label>
          <Input id="staff-device-activation" type="password" maxLength={38} value={activationCode}
            autoComplete="off" spellCheck={false} disabled={busy}
            onChange={(event) => setActivationCode(event.target.value.trim())} />
          {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}
          <Button className="min-h-11 w-full" disabled={busy || !/^(?:neods_)?[0-9a-f]{32}$/i.test(activationCode)}>
            {busy ? "Activating…" : "Activate device"}
          </Button>
        </form>
        <Link to="/device-authorisation" className="flex min-h-11 items-center justify-center text-sm font-semibold text-neo-aqua">
          Manage device authorisation
        </Link>
        {device ? <button type="button" disabled={busy} className="min-h-11 w-full text-sm font-semibold"
          onClick={() => { setActivating(false); setActivationCode(""); setFormError(null); }}>
          Back to staff PIN
        </button> : null}
      </section>
    );
  }

  return (
    <form
      data-neo-staff-pin-login
      onSubmit={handleSubmit}
      className="space-y-5"
    >
      <div className="rounded-2xl border border-neo-turquoise/30 bg-neo-turquoise/5 p-4">
        <div className="flex items-start gap-3">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-neo-turquoise/15 text-neo-aqua">
            <ShieldCheck className="size-5" aria-hidden />
          </span>

          <div className="min-w-0">
            <p className="font-semibold text-neo-midnight">
              {device.propertyName}
            </p>
            <p className="truncate text-xs text-neo-steel">
              Trusted device: {device.label}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label
          htmlFor="staff-pin"
          className="text-sm font-medium text-neo-midnight"
        >
          Personal six-digit PIN
        </label>

        <Input
          id="staff-pin"
          type="password"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          autoComplete="off"
          value={pin}
          disabled={busy}
          onChange={(event) =>
            setPin(
              event.target.value.replace(/\D/g, "").slice(0, 6),
            )
          }
          aria-describedby="staff-pin-help"
          className="h-14 rounded-xl text-center text-2xl tracking-[0.45em]"
        />

        <p
          id="staff-pin-help"
          className="text-center text-xs text-neo-steel"
        >
          Your identity, property access and role permissions are
          checked by NEØ before the session opens.
        </p>
      </div>

      <div
        aria-label="PIN keypad"
        className="grid grid-cols-3 gap-2"
      >
        {DIGITS.map((digit) => (
          <button
            key={digit}
            type="button"
            disabled={busy}
            onClick={() => appendDigit(digit)}
            className="h-12 rounded-xl border border-neo-mist bg-white text-base font-semibold text-neo-midnight transition hover:border-neo-turquoise hover:bg-neo-cloud disabled:opacity-50"
          >
            {digit}
          </button>
        ))}

        <button
          type="button"
          disabled={busy || pin.length === 0}
          onClick={deleteDigit}
          aria-label="Delete last digit"
          className="grid h-12 place-items-center rounded-xl border border-neo-mist bg-white text-neo-steel transition hover:border-neo-turquoise hover:text-neo-midnight disabled:opacity-50"
        >
          <Delete className="size-4" aria-hidden />
        </button>

        <button
          type="button"
          disabled={busy}
          onClick={() => appendDigit("0")}
          className="h-12 rounded-xl border border-neo-mist bg-white text-base font-semibold text-neo-midnight transition hover:border-neo-turquoise hover:bg-neo-cloud disabled:opacity-50"
        >
          0
        </button>

        <button
          type="button"
          disabled={busy || pin.length === 0}
          onClick={() => {
            setPin("");
            setFormError(null);
          }}
          className="h-12 rounded-xl border border-neo-mist bg-white text-sm font-medium text-neo-steel transition hover:border-neo-turquoise hover:text-neo-midnight disabled:opacity-50"
        >
          Clear
        </button>
      </div>

      {formError ? (
        <p
          role="alert"
          className="text-sm font-medium text-destructive"
        >
          {formError}
        </p>
      ) : null}

      <Button
        type="submit"
        disabled={busy || pin.length !== 6}
        className="h-12 w-full rounded-xl bg-neo-turquoise font-semibold text-neo-midnight hover:bg-neo-aqua hover:text-white"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Checking PIN…
          </>
        ) : (
          "Sign in with PIN"
        )}
      </Button>

      <button type="button" disabled={busy} onClick={() => { setActivating(true); setFormError(null); }}
        className="min-h-11 w-full text-sm font-semibold text-neo-aqua">
        Enter an activation code
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={forgetDevice}
        className="w-full text-center text-xs font-medium text-neo-steel hover:text-destructive hover:underline"
      >
        Forget this browser's PIN setup
      </button>
    </form>
  );
}
