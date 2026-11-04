import { ContactNote } from "../models/ContactNote.js";
import { logActivity } from "./contactIntel.js";

/** The old single notes field becomes the contact's first note, with its original timestamp. */
export async function migrateLegacyNote(contact) {
  if (contact.notesMigrated) return;
  const text = (contact.notes ?? "").trim();
  if (text) {
    const at = contact.noteUpdatedAt ?? contact.updatedAt ?? new Date();
    const note = new ContactNote({ userId: contact.userId, contactId: contact._id, text: contact.notes });
    note.$timestamps(false);
    note.createdAt = at;
    note.updatedAt = at;
    await note.save();
  }
  contact.notesMigrated = true;
}

/** Keep the contact's notes summary (shown in the table) in step with its newest note. */
export async function refreshNoteSummary(contact) {
  const latest = await ContactNote.findOne({ userId: contact.userId, contactId: contact._id, deletedAt: null }).sort({ updatedAt: -1 });
  contact.notes = latest?.text ?? "";
  contact.noteUpdatedAt = latest?.updatedAt ?? null;
  contact.lastActivityAt = new Date();
}

export async function addNote(contact, text) {
  await migrateLegacyNote(contact);
  const note = await ContactNote.create({ userId: contact.userId, contactId: contact._id, text });
  await refreshNoteSummary(contact);
  await contact.save();
  await logActivity({ userId: contact.userId, contactId: contact._id, type: "note_added", description: "Note added", metadata: { text: text.slice(0, 300) } });
  return note;
}

export async function editNote(contact, note, text) {
  if (note.text === text) return note;
  note.versions.push({ text: note.text, savedAt: note.updatedAt });
  note.text = text;
  await note.save();
  await refreshNoteSummary(contact);
  await contact.save();
  await logActivity({ userId: contact.userId, contactId: contact._id, type: "note_edited", description: "Note edited", metadata: { text: text.slice(0, 300) } });
  return note;
}

export async function deleteNote(contact, note) {
  note.deletedAt = new Date();
  await note.save();
  await refreshNoteSummary(contact);
  await contact.save();
  await logActivity({ userId: contact.userId, contactId: contact._id, type: "note_deleted", description: "Note deleted", metadata: { text: note.text.slice(0, 300) } });
}

/** The Edit Contact form has one notes box: it edits the newest note, adds one, or clears it. */
export async function saveNotesFromForm(contact, text) {
  await migrateLegacyNote(contact);
  const latest = await ContactNote.findOne({ userId: contact.userId, contactId: contact._id, deletedAt: null }).sort({ updatedAt: -1 });
  if (!text.trim()) {
    if (latest) await deleteNote(contact, latest);
    else {
      contact.notes = "";
      contact.noteUpdatedAt = null;
    }
    return;
  }
  if (latest) await editNote(contact, latest, text);
  else await addNote(contact, text);
}
