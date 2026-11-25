import os from "node:os";
import {
  bindConversation,
  type LinkResult,
  linkProjectAlias,
  readClaudeConversations,
} from "@ocean/core/shared/project-resolution.js";
import { refreshClaudeProjects } from "../pull/server-capture.js";

// Re-reads the caches so the chat just used has its title and Claude project on file before a
// capture or a link reads them. A failed read only leaves the last list in place.
export async function refreshClaudeConversations(
  home = os.homedir(),
): Promise<void> {
  await refreshClaudeProjects(home).catch(() => undefined);
}

export type DesktopLink =
  | { status: "absent" }
  | {
      status: "linked";
      uuid: string;
      project: string;
      claudeProject?: string;
      alias?: LinkResult;
    };

// The reader is the caller's (interfaces wire Desktop's store in): this layer never opens it.
export type DesktopChatList = () => Promise<
  | { status: "absent" }
  | { status: "ok"; conversations: { uuid: string; updatedAt: string }[] }
>;

// `ocean desktop link <id>` (T-333, behind `ocean_project_link`): the newest Desktop chat is
// bound to the project, and the Claude project it sits in becomes that project's alias, so the
// project's other chats follow without being linked one by one. A Claude project name another
// project already answers to is left with it (alias.conflict says which).
export async function linkLatestDesktopChat(options: {
  project: string;
  read: DesktopChatList;
  refresh?: () => Promise<void>;
}): Promise<DesktopLink> {
  await (options.refresh ?? refreshClaudeConversations)();
  const read = await options.read();
  if (read.status === "absent") return { status: "absent" };
  const latest = read.conversations.reduce<
    (typeof read.conversations)[number] | undefined
  >(
    (best, each) =>
      !best ||
      (Date.parse(each.updatedAt) || 0) > (Date.parse(best.updatedAt) || 0)
        ? each
        : best,
    undefined,
  );
  if (!latest) return { status: "absent" };
  await bindConversation(latest.uuid, options.project);
  const claudeProject = (await readClaudeConversations())[latest.uuid]
    ?.projectName;
  return {
    status: "linked",
    uuid: latest.uuid,
    project: options.project,
    ...(claudeProject
      ? {
          claudeProject,
          alias: await linkProjectAlias(claudeProject, options.project),
        }
      : {}),
  };
}
