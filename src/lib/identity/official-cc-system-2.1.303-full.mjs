import { CRS_OFFICIAL_AGENT_PROMPT } from './official-cc-system-2.1.241.mjs'

const LEGACY_INTRO = 'You are an interactive agent that helps users with software engineering tasks.'
const OFFICIAL_303_INTRO =
  'You are an interactive agent that helps users according to your "Output Style", which describes how you should respond to user queries.'

export const CRS_OFFICIAL_AGENT_PROMPT_303 = CRS_OFFICIAL_AGENT_PROMPT.replace(LEGACY_INTRO, OFFICIAL_303_INTRO)
