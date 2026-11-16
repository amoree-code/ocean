import { factTarget } from "@ocean/brain/memory/fact-routing.js";
import { proposeMemory } from "@ocean/brain/memory/memory-write.js";
import { MemoryContractError } from "@ocean/core/domain/mcp/memory-contract.js";
import {
  type ProposalResult,
  proposeInterests,
  topicProposal,
} from "../brief/interest-discovery.js";

// Onboarding for any user (T-314): the `interests` step of `ocean onboard` asks three questions
// (the identity step already asks the role). The answers are the user's own words, but they still
// go to review like every other proposal: goals as a fact candidate, stack and topics as interest
// candidates. Nothing is written as memory here.

export const ONBOARDING_QUESTIONS = [
  {
    key: "stack",
    question: "Which tools and frameworks do you use? (comma separated)",
  },
  {
    key: "goals",
    question:
      "What are you working towards this year? (one per line or ; separated)",
  },
  {
    key: "topics",
    question: "Which topics do you want to follow? (comma separated)",
  },
] as const;

export type OnboardingAnswers = Partial<
  Record<(typeof ONBOARDING_QUESTIONS)[number]["key"], string>
>;

const items = (text: string | undefined, split: RegExp) =>
  [
    ...new Set(
      (text ?? "")
        .split(split)
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter((item) => item && item.length <= 80),
    ),
  ].slice(0, 20);

export async function onboard(answers: OnboardingAnswers): Promise<{
  facts: string[];
  interests: ProposalResult;
}> {
  const facts: string[] = [];
  const fact = async (
    type: "identity" | "goal",
    title: string,
    content: string,
  ) => {
    try {
      const { candidate } = await proposeMemory({
        content,
        origin: "inferred",
        source: "setup-onboarding",
        target: await factTarget({ type, title }),
        reason: "answered at ocean setup --onboard",
        meta: { type },
      });
      facts.push(candidate);
    } catch (error) {
      if (!(error instanceof MemoryContractError)) throw error;
    }
  };
  const goals = items(answers.goals, /[;\n]/);
  if (goals.length)
    await fact(
      "goal",
      "goals",
      `# Goals\n\n${goals.map((goal) => `- **${goal}**`).join("\n")}\n`,
    );
  const topics = [
    ...items(answers.stack, /[,;\n]/).map((topic) =>
      topicProposal(topic, "named in your stack at setup"),
    ),
    ...items(answers.topics, /[,;\n]/).map((topic) =>
      topicProposal(topic, "a topic you asked to follow at setup"),
    ),
  ];
  const interests = await proposeInterests(topics, {
    apply: true,
    origin: "onboarding",
    source: "setup-onboarding",
  });
  return { facts, interests };
}
