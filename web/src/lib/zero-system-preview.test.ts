import { describe, expect, it } from 'vitest'
import {
  CLI_IDENTITY,
  DEFAULT_PERSONA_TEMPLATES,
  previewBillingVars,
  previewSystemBlocks,
} from './persona-template'

describe('zero caller system preview', () => {
  const caller = 'Keep the caller instructions.'
  const billingVars = {
    ...previewBillingVars({}, '2.1.303'),
    identity_cli: CLI_IDENTITY,
  }

  it('previews billing with prompt_version=<CLI_IDENTITY> and preserves caller system with zero injected prompts', () => {
    const blocks = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.zero,
      { ...billingVars, caller_system: caller },
      { preserveCallerSystem: true, includeBilling: true }
    )
    expect(blocks).toEqual([
      {
        id: 'billing',
        text: `${billingVars.billing_semi} prompt_version=<${CLI_IDENTITY}>`,
        hide: false,
        ttl: '',
        scope: '',
        placeholder: false,
      },
      {
        id: 'caller_system',
        text: caller,
        hide: false,
        ttl: '',
        scope: '',
        placeholder: false,
      },
    ])
  })

  it('previews only billing with prompt_version=<CLI_IDENTITY> when caller system is absent', () => {
    for (const caller_system of ['', ' \n ']) {
      const blocks = previewSystemBlocks(
        DEFAULT_PERSONA_TEMPLATES.zero,
        { ...billingVars, caller_system },
        { preserveCallerSystem: true, includeBilling: true }
      )
      expect(blocks).toEqual([
        {
          id: 'billing',
          text: `${billingVars.billing_semi} prompt_version=<${CLI_IDENTITY}>`,
          hide: false,
          ttl: '',
          scope: '',
          placeholder: false,
        },
      ])
    }
  })

  it('shows caller system when billing vars are omitted', () => {
    const blocks = previewSystemBlocks(
      DEFAULT_PERSONA_TEMPLATES.zero,
      { caller_system: caller },
      { preserveCallerSystem: true }
    )
    expect(blocks).toEqual([
      {
        id: 'caller_system',
        text: caller,
        hide: false,
        ttl: '',
        scope: '',
        placeholder: false,
      },
    ])
  })

  it('does not duplicate caller text explicitly placed by a custom template', () => {
    const blocks = previewSystemBlocks(
      [
        ...DEFAULT_PERSONA_TEMPLATES.zero,
        { id: 'instructions', type: 'text', text: 'Rules: {{caller_system}}' },
      ],
      { caller_system: caller },
      { preserveCallerSystem: true }
    )
    expect(blocks).toHaveLength(1)
    expect(blocks[0].text).toBe(`Rules: ${caller}`)
  })

  it('adds no placeholder when the caller example is hidden or absent without billing', () => {
    for (const caller_system of ['', ' \n ']) {
      expect(
        previewSystemBlocks(
          DEFAULT_PERSONA_TEMPLATES.zero,
          { caller_system },
          { preserveCallerSystem: true }
        )
      ).toEqual([])
    }
  })

  it('does not change preview behavior without the zero option or billing vars', () => {
    expect(
      previewSystemBlocks(DEFAULT_PERSONA_TEMPLATES.zero, {
        caller_system: caller,
      })
    ).toEqual([])
  })
})
