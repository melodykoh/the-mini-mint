import { useState, useCallback } from 'react'

export interface ActionSummary {
  title: string
  details: string[]
  balanceImpact?: string
  warning?: string
}

type Phase = 'idle' | 'confirming' | 'success'

interface ActionFlowState {
  phase: Phase
  summary: ActionSummary | null
  result: string | null
  error: string | null
  isSubmitting: boolean
}

interface ActionFlowActions {
  requestConfirmation: (summary: ActionSummary) => void
  confirm: (action: () => Promise<string>) => Promise<void>
  cancel: () => void
  reset: () => void
  setError: (msg: string | null) => void
}

export type ActionFlow = ActionFlowState & ActionFlowActions

const INITIAL_STATE: ActionFlowState = {
  phase: 'idle',
  summary: null,
  result: null,
  error: null,
  isSubmitting: false,
}

export function useActionFlow(): ActionFlow {
  const [state, setState] = useState<ActionFlowState>(INITIAL_STATE)

  const requestConfirmation = useCallback((summary: ActionSummary) => {
    setState({
      phase: 'confirming',
      summary,
      result: null,
      error: null,
      isSubmitting: false,
    })
  }, [])

  const confirm = useCallback(async (action: () => Promise<string>) => {
    setState((prev) => ({ ...prev, isSubmitting: true, error: null }))
    try {
      const result = await action()
      setState({
        phase: 'success',
        summary: null,
        result,
        error: null,
        isSubmitting: false,
      })
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : err && typeof err === 'object' && 'message' in err
            ? String((err as { message: string }).message)
            : 'Something went wrong. Please try again.'
      setState((prev) => ({
        ...prev,
        isSubmitting: false,
        error: message,
      }))
    }
  }, [])

  const cancel = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  const reset = useCallback(() => {
    setState(INITIAL_STATE)
  }, [])

  const setError = useCallback((msg: string | null) => {
    setState((prev) => ({ ...prev, error: msg }))
  }, [])

  return {
    ...state,
    requestConfirmation,
    confirm,
    cancel,
    reset,
    setError,
  }
}
