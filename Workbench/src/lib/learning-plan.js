// Pure client-side mapping from a repository summary to an EDITABLE learning
// plan draft. The draft is only pre-fill for the user's own form: nothing here
// persists, changes learning state, or marks anything completed. The server
// remains the sole writer of learning content (PATCH /api/learning/:id/plan).
// No summary (or no learningGoalCandidates) yields null so the manual path
// stays available.

const MAX_DRAFT_MILESTONES = 20;
const MAX_MILESTONE_TITLE = 200;

function splitMilestones(useCases) {
  if (typeof useCases !== "string") return [];
  const lines = useCases
    .split(/\r?\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•▪\d]+[.)]?)\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_DRAFT_MILESTONES);
  return lines.map((title, index) => ({
    milestoneId: `milestone-${index + 1}`,
    title: title.length > MAX_MILESTONE_TITLE ? title.slice(0, MAX_MILESTONE_TITLE) : title,
    done: false,
  }));
}

export function planDraftFromSummary(summary) {
  const sections = summary?.sections;
  if (!sections || typeof sections !== "object") return null;
  const learningGoal = typeof sections.learningGoalCandidates === "string"
    ? sections.learningGoalCandidates.trim()
    : "";
  if (!learningGoal) return null;
  const outcomeParts = [sections.problemSolved, sections.coreCapabilities]
    .filter((part) => typeof part === "string" && part.trim())
    .map((part) => part.trim());
  return {
    learningGoal,
    expectedOutcome: outcomeParts.join("\n\n").slice(0, 3000),
    milestones: splitMilestones(sections.suitableUseCases),
    currentMilestone: null,
  };
}