import type { SpeakerTurn, Word } from "./types";

export function groupWordsBySpeaker(words: Word[]): SpeakerTurn[] {
  const turns: SpeakerTurn[] = [];
  for (const word of words) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === word.speaker) last.words.push(word);
    else turns.push({ speaker: word.speaker, words: [word] });
  }
  return turns;
}
