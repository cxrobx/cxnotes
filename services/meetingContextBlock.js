/**
 * The meeting context block: what was known about a meeting BEFORE anyone
 * spoke — its title, its invite list and its agenda — rendered for the
 * summariser prompt.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHAT IT IS GUARDING
 *
 * An invite list is a list of people who were ASKED. It is not a record of who
 * turned up, and the two differ constantly: people are invited and do not
 * attend, and people attend who were never on the invite. Handing a model a
 * line that reads `- Participants: A, B` alongside a `## Participants` section
 * to fill in produces an attendance list out of a guest list, in a document
 * that then gets filed, re-read months later and quoted back to the client.
 *
 * That is not hypothetical. On 2026-08-21 a call was summarised as attended by
 * "Chris, Evan Lewis, Dominic Sawyer". The dominant voice on the recording was
 * a fourth person who never RSVP'd and therefore never reached the roster, and
 * at least one of the two named people has no attributable line in the
 * transcript at all. Nothing in the pipeline observed attendance; the invite
 * list was simply relabelled as one.
 *
 * The `speakerNames` block already holds the correct instinct for its own
 * input — "a wrongly attributed quote is worse than an unattributed one" — and
 * correctly renders nothing when it knows nothing. The failure was that the
 * careful path went quiet and this one, which had no such guard, spoke in its
 * place. So the guard belongs on BOTH paths, which is what this module adds.
 *
 * The invite list is still worth sending. It is a good SPELLING reference for
 * names that do appear ("Dominic Sawyer" rescues a transcript's "Domnic"), and
 * a good agenda anchor. It is only ever wrong as evidence of presence.
 *
 * Same empty-string contract as `renderMarkersBlock`, `renderSlidesBlock` and
 * `renderSpeakerBlock`: no context → empty string → a prompt byte-identical to
 * one built before this module existed.
 *
 * British English throughout (invariant #4): "organiser", "normalise".
 */

/**
 * Render the pre-meeting context for the summary prompt.
 *
 * @param {object} ctx - manifest.meetingContext ({ title, participants, agenda })
 * @param {object} [options]
 * @param {string} [options.systemLabel='Remote'] - the track label to fall back
 *   to when a speaker cannot be identified, so the instruction names the same
 *   string the transcript actually uses.
 * @returns {string} the prompt block, or '' when there is no context at all.
 */
function renderContextBlock(ctx = {}, options = {}) {
  const context = ctx && typeof ctx === 'object' ? ctx : {};
  const systemLabel = options.systemLabel || 'Remote';

  const title = str(context.title);
  const participants = str(context.participants);
  const agenda = str(context.agenda);

  if (!title && !participants && !agenda) return '';

  let block = '\n\nMeeting context, known before the meeting started:\n';
  if (title) block += `- Meeting title: ${title}\n`;
  // "Invited", never "Participants" — the section heading the model has to
  // fill in is called Participants, and an exact word match invites a copy.
  if (participants) block += `- Invited (from the invitation, NOT an attendance record): ${participants}\n`;
  if (agenda) block += `- Agenda/notes: ${agenda}\n`;

  block += '\nThis was all written before anyone spoke.';
  if (agenda) block += ' Reference the agenda topics where the transcript covers them.';

  if (participants) {
    block += `\n\nThe invited list is a SPELLING REFERENCE for names that do appear in the `
      + `transcript, and nothing more. People are routinely invited and do not attend, and `
      + `people attend who were never invited. So:\n`
      + `- Build the Participants section from the TRANSCRIPT, not from the invited list.\n`
      + `- Do not list an invited person as present unless the transcript shows them speaking, `
      + `or shows someone addressing them by name.\n`
      + `- If someone clearly spoke but cannot be identified, keep "${systemLabel}" rather than `
      + `assigning them one of the invited names. An unnamed speaker is honest; a wrong name `
      + `survives into the note, into the vault, and into whatever gets sent to the other person.\n`
      + `- If the transcript names someone who is not on the invited list, use that name. The `
      + `list is incomplete far more often than it is wrong.\n`
      + `- Transcripts mis-hear names constantly, and greetings and asides are the worst of it. `
      + `A name that appears exactly once, matches nobody on the invited list, and is never used `
      + `again is far more likely to be a mis-transcription than a person — leave it out rather `
      + `than listing it. Where a transcribed name is close to an invited one, prefer the invited `
      + `spelling.\n`;
  }

  return block;
}

function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

module.exports = {
  renderContextBlock,
};
