import { useState } from "react";
import { Delete, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  clearTrustedStaffDevice,
  readTrustedStaffDevice,
  signInWithStaffPin,
} from "@/lib/staff-pin-login";

const DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"];

export function StaffPinSignIn() {
  const [device, setDevice] = useState(() =>
    readTrustedStaffDevice(),
  );
  const [pin, setPin] = useState("");
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

  if (!device) {
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
                This device is not yet authorised
              </h2>

              <p className="text-sm leading-relaxed text-neo-steel">
                An authorised workforce administrator must first sign
                in normally, select this property, and authorise this
                browser for staff PIN access.
              </p>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-neo-steel">
          Personal PINs never grant access to an untrusted device.
        </p>
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

      <button
        type="button"
        disabled={busy}
        onClick={forgetDevice}
        className="w-full text-center text-xs font-medium text-neo-steel hover:text-destructive hover:underline"
      >
        Remove this device’s PIN access
      </button>
    </form>
  );
}