// crewRecipes.ts
//
// Crew Recipes — one-shot multi-agent mission templates.
//
// A CrewRecipe is a named, reusable team formation: a small set of agents, each
// with its own role-prompt, plus the Agent Relay handoff chain that wires them
// together (with Smart Relay / includeBoard on, so each finish passes the baton
// PLUS the team's accumulated Brief Board findings to the next agent). Picking a
// recipe spawns the whole crew, delivers every role-prompt as a pendingPrompt,
// auto-arranges, and pre-wires the relay rules — turning "assemble agents by
// hand" into "pick a mission, press go".
//
// PURITY CONTRACT: this module is PURE DATA + the AgentKind type ONLY. It imports
// no zustand store, no React, and no IPC, so it stays trivially unit-testable and
// can be consumed from anywhere (canvas store, command palette, top bar, AI
// actions) without creating an import cycle. The actual orchestration (addNode +
// addRule + arrange) lives in canvas.runRecipe(); recipes themselves are static
// code constants that are NEVER serialized or persisted.

import type { AgentKind } from '../store/canvas'
import { t } from '../store/i18n'

/** One agent slot in a recipe. Endpoints in `handoffs` reference these by index. */
export interface RecipeAgent {
  /** which agent persona/CLI to spawn for this role. */
  agent: AgentKind
  /** the node title (also the human-facing role name, e.g. "Arquitecto"). */
  title: string
  /** the role-prompt delivered as the node's pendingPrompt once it is ready. */
  prompt: string
  /**
   * Agent Objectives — optional explicit GOAL for this role (a one-line mission +
   * an optional tiny checklist of done-signals). When omitted, runRecipe falls
   * back to auto-seeding the goal from `prompt` (objectiveTextFromPrompt). Pure
   * data; it makes a recipe a MEASURABLE mission. Typed loosely here ({text,
   * checklist?}) so crewRecipes.ts keeps its no-store/no-cycle purity contract —
   * it is shaped exactly like lib/objective.ts's Objective.
   */
  objective?: { text: string; checklist?: { label: string; done?: boolean }[] }
  /** optional preferred width; arrange() will retile anyway, so this is a hint. */
  relW?: number
  /** optional preferred height; arrange() will retile anyway, so this is a hint. */
  relH?: number
}

/** One handoff edge. `from`/`to` are INDICES into the recipe's `agents` array,
 *  resolved to real node ids at runtime by runRecipe(). */
export interface RecipeHandoff {
  /** index into agents[] of the source agent (whose finish fires the handoff). */
  from: number
  /** index into agents[] of the target agent (who receives the baton). */
  to: number
  /** the baton instruction written into the target terminal. */
  text: string
  /** Smart Relay: prepend the live Brief Board to the baton (default true). */
  includeBoard?: boolean
}

/** A complete, reusable multi-agent mission template. */
export interface CrewRecipe {
  id: string
  /** human-facing title (also fuzzy-matched by the AI run_recipe action). */
  title: string
  /** small leading glyph for menus / palette rows. */
  icon: string
  /** keywords folded into the command-palette search haystack. */
  keywords: string
  /** the agents to spawn, in order. */
  agents: RecipeAgent[]
  /** the relay handoff chain wiring agents[] together (endpoints are indices). */
  handoffs: RecipeHandoff[]
}

/** Hard cap on crew size, so a recipe can never spawn an unbounded swarm. */
export const MAX_CREW = 4

/**
 * Seed recipes — proven team formations encoded as static constants. Each prompt
 * is a short Spanish role instruction; each handoff text is the baton the next
 * agent receives (with includeBoard:true so it carries the shared findings).
 */
export const CREW_RECIPES: CrewRecipe[] = [
  {
    id: 'ship-feature',
    title: t('crewRecipes.ship_feature.title'),
    icon: '🚀',
    keywords: 'ship feature enviar funcionalidad arquitecto implementador revisor equipo crew',
    agents: [
      {
        agent: 'claude',
        title: t('crewRecipes.role.architect'),
        prompt: t('crewRecipes.ship_feature.prompt_architect')
      },
      {
        agent: 'cursor',
        title: t('crewRecipes.role.implementer'),
        prompt: t('crewRecipes.ship_feature.prompt_implementer')
      },
      {
        agent: 'codex',
        title: t('crewRecipes.role.reviewer'),
        prompt: t('crewRecipes.ship_feature.prompt_reviewer')
      }
    ],
    handoffs: [
      {
        from: 0,
        to: 1,
        text: t('crewRecipes.ship_feature.handoff_implement'),
        includeBoard: true
      },
      {
        from: 1,
        to: 2,
        text: t('crewRecipes.ship_feature.handoff_review'),
        includeBoard: true
      }
    ]
  },
  {
    id: 'fix-build',
    title: t('crewRecipes.fix_build.title'),
    icon: '🛠️',
    keywords: 'fix build arreglar compilacion error diagnosticar reparar crew',
    agents: [
      {
        agent: 'codex',
        title: t('crewRecipes.role.diagnostician'),
        prompt: t('crewRecipes.fix_build.prompt_diagnose'),
        objective: {
          text: t('crewRecipes.fix_build.objective_diagnose'),
          checklist: [{ label: t('crewRecipes.fix_build.check_root_cause') }]
        }
      },
      {
        agent: 'claude',
        title: t('crewRecipes.role.fixer'),
        prompt: t('crewRecipes.fix_build.prompt_fix'),
        objective: {
          text: t('crewRecipes.fix_build.objective_fix'),
          checklist: [
            { label: t('crewRecipes.fix_build.check_build_green') },
            { label: t('crewRecipes.fix_build.check_zero_errors') }
          ]
        }
      }
    ],
    handoffs: [
      {
        from: 0,
        to: 1,
        text: t('crewRecipes.fix_build.handoff_fix'),
        includeBoard: true
      }
    ]
  },
  {
    id: 'research-summarize',
    title: t('crewRecipes.research_summarize.title'),
    icon: '🔎',
    keywords: 'research investigar resumir summary documentar crew equipo',
    agents: [
      {
        agent: 'claude',
        title: t('crewRecipes.role.researcher'),
        prompt: t('crewRecipes.research_summarize.prompt_researcher')
      },
      {
        agent: 'cursor',
        title: t('crewRecipes.role.writer'),
        prompt: t('crewRecipes.research_summarize.prompt_writer')
      }
    ],
    handoffs: [
      {
        from: 0,
        to: 1,
        text: t('crewRecipes.research_summarize.handoff_summarize'),
        includeBoard: true
      }
    ]
  },
  {
    id: 'refactor-test',
    title: t('crewRecipes.refactor_test.title'),
    icon: '♻️',
    keywords: 'refactor test tests pruebas limpiar mejorar crew equipo',
    agents: [
      {
        agent: 'cursor',
        title: t('crewRecipes.role.refactorer'),
        prompt: t('crewRecipes.refactor_test.prompt_refactorer')
      },
      {
        agent: 'codex',
        title: t('crewRecipes.role.tester'),
        prompt: t('crewRecipes.refactor_test.prompt_tester')
      }
    ],
    handoffs: [
      {
        from: 0,
        to: 1,
        text: t('crewRecipes.refactor_test.handoff_test'),
        includeBoard: true
      }
    ]
  }
]

/** Look up a recipe by exact id. Returns null when unknown. */
export function recipeById(id: string): CrewRecipe | null {
  return CREW_RECIPES.find((r) => r.id === id) ?? null
}

/** Accent/case-insensitive normalization (mirrors aiActions/voiceCommands). */
function norm(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
}

/**
 * Fuzzy-match a recipe by free-text name (used by the AI run_recipe action and
 * any voice phrase). Ladder: exact id/title > startsWith (either way, len>=3) >
 * includes (either way, len>=3) > keyword hit. Returns null when nothing matches.
 */
export function matchRecipe(name: string): CrewRecipe | null {
  const q = norm(name)
  if (!q) return null
  const byId = CREW_RECIPES.find((r) => r.id === q || norm(r.title) === q)
  if (byId) return byId
  const starts = CREW_RECIPES.find((r) => {
    const t = norm(r.title)
    return t.startsWith(q) || (t.length >= 3 && q.startsWith(t))
  })
  if (starts) return starts
  const includes = CREW_RECIPES.find((r) => {
    const t = norm(r.title)
    return t.includes(q) || (t.length >= 3 && q.includes(t))
  })
  if (includes) return includes
  const byKeyword = CREW_RECIPES.find((r) => norm(r.keywords).includes(q))
  return byKeyword ?? null
}
