import { useEffect, useState, type FormEvent } from "react";
import { SettingsSchema } from "../../../shared/settings";
import { fetchSettings, saveSettings } from "../api/settings";
import { Button } from "../components/Button";
import { TextField } from "../components/TextField";

export function SettingsPage() {
  const [displayName, setDisplayName] = useState("");
  const [emailUpdates, setEmailUpdates] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetchSettings()
      .then((settings) => {
        setDisplayName(settings.displayName);
        setEmailUpdates(settings.emailUpdates);
      })
      .catch(() => {
        /* the auth guard already redirects; nothing to recover here */
      });
  }, []);

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = SettingsSchema.safeParse({ displayName, emailUpdates });
    if (!parsed.success) {
      setError("Display name is required");
      return;
    }
    await saveSettings(parsed.data);
    setError(null);
    setSaved(true);
  };

  return (
    <section>
      <h1>Settings</h1>
      <form onSubmit={handleSave}>
        <TextField
          id="display-name"
          label="Display name"
          value={displayName}
          onChange={(event) => {
            setDisplayName(event.target.value);
            setSaved(false);
          }}
          error={error ?? undefined}
        />
        <div className="field">
          <label>
            <input
              type="checkbox"
              checked={emailUpdates}
              onChange={(event) => {
                setEmailUpdates(event.target.checked);
                setSaved(false);
              }}
            />{" "}
            Email me a weekly summary
          </label>
        </div>
        <Button type="submit">Save changes</Button>
        {saved ? <span className="status-message"> Settings saved</span> : null}
      </form>
    </section>
  );
}
