import type { ContactField, StoredContact } from '@/lib/quote-workflow/backend-bind';
import { Field, paneFieldClass, Section } from '../pane-ui';
import { useState } from 'react';

const FIELDS: Array<{ field: ContactField; label: string }> = [
  { field: 'name', label: 'Name' },
  { field: 'company', label: 'Company / agency' },
  { field: 'endClient', label: 'End client' },
  { field: 'email', label: 'Email' },
  { field: 'phone', label: 'Phone' },
];

const NO_CONTACT: StoredContact = {
  name: null,
  company: null,
  endClient: null,
  email: null,
  phone: null,
};

/**
 * Contact block (U16, R4): the core details from the email, at the top of the pane. Each field is editable, and each
 * change goes to `onEdit` as it is typed (the pane debounces it into one event). A field with no value is empty, not
 * hidden. While the mail is still being read, or has no stored read, the fields are blank and nothing is logged.
 */
export function ContactBlock({
  contact,
  onEdit,
}: {
  contact: StoredContact | null;
  onEdit: (field: ContactField, value: string | null) => void;
}) {
  // The block is keyed by the mail and its work item, so a new mail or a landed read starts from its own values.
  const [values, setValues] = useState<StoredContact>(contact ?? NO_CONTACT);
  return (
    <Section title="Contact" id="quote-contact">
      <div className="grid grid-cols-2 gap-x-2.5 gap-y-2">
        {FIELDS.map(({ field, label }) => (
          <Field key={field} label={label} htmlFor={`quote-contact-${field}`}>
            <input
              id={`quote-contact-${field}`}
              className={paneFieldClass}
              maxLength={200}
              value={values[field] ?? ''}
              onChange={(event) => {
                const next = event.target.value;
                setValues((prev) => ({ ...prev, [field]: next }));
                onEdit(field, next.trim() || null);
              }}
            />
          </Field>
        ))}
      </div>
    </Section>
  );
}
