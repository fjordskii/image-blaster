import { useEffect, useState, type FormEvent } from 'react'
import { useLocation } from 'wouter'
import { ImageSquareIcon } from '@phosphor-icons/react'
import type { WorldEntry } from '../types/world'
import { AppButton } from './AppButton'
import { chrome } from './AppChrome'
import {
  ACTIVE_JOB_STORAGE_KEY,
  RemoteApiError,
  type RemoteJob,
  compressImageFile,
  listRemoteState,
  pollGeneration,
  readGateSecret,
  startGeneration,
  writeGateSecret,
} from '../remote/client'

interface Props {
  variant: 'page' | 'sidebar'
  onWorldReady: (entry: WorldEntry) => void
  onWorldsChanged: () => void
}

export function RemoteGenerate({ variant, onWorldReady, onWorldsChanged }: Props) {
  const [, navigate] = useLocation()
  const [secret, setSecret] = useState(readGateSecret)
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [open, setOpen] = useState(variant === 'page')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operationId, setOperationId] = useState<string | null>(null)
  const [job, setJob] = useState<RemoteJob | null>(null)

  useEffect(() => {
    const saved = window.sessionStorage.getItem(ACTIVE_JOB_STORAGE_KEY)
    if (saved) {
      setOperationId(saved)
      return
    }
    if (!readGateSecret()) return
    let cancelled = false
    listRemoteState().then((state) => {
      if (cancelled || !state) return
      const active = state.jobs.find((item) => item.status === 'running' || item.status === 'persisting')
      if (!active) return
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, active.operationId)
      setOperationId(active.operationId)
      setJob(active)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!operationId) return
    let cancelled = false
    const run = async () => {
      let failures = 0
      while (!cancelled) {
        let wait = 5000
        try {
          const next = await pollGeneration(operationId)
          if (cancelled) return
          failures = 0
          setJob(next)
          if (next.status === 'completed' && next.entry) {
            window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY)
            onWorldReady(next.entry)
            navigate(`/${next.entry.slug}`)
            return
          }
          if (next.status === 'failed') {
            window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY)
            setError(next.error || 'Generation failed.')
            return
          }
          wait = next.status === 'persisting' ? 1200 : 5000
        } catch (pollError) {
          failures += 1
          if (
            pollError instanceof RemoteApiError
            && (pollError.status === 401 || pollError.status === 400 || pollError.status === 404)
          ) {
            window.sessionStorage.removeItem(ACTIVE_JOB_STORAGE_KEY)
            setError(pollError.message)
            return
          }
          if (failures > 8) {
            setError(pollError instanceof Error ? pollError.message : 'Lost contact with the server.')
            return
          }
        }
        await sleep(wait)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [navigate, onWorldReady, operationId])

  useEffect(() => {
    if (operationId) setOpen(true)
  }, [operationId])

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl)
  }, [previewUrl])

  const saveSecret = (value: string) => {
    const trimmed = value.trim()
    setSecret(trimmed)
    if (trimmed === readGateSecret()) return
    writeGateSecret(trimmed)
    onWorldsChanged()
  }

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setError(null)
    const trimmed = secret.trim()
    if (!trimmed) {
      setError('Enter the gate secret first.')
      return
    }
    if (!file) {
      setError('Choose an image.')
      return
    }
    writeGateSecret(trimmed)
    setSubmitting(true)
    try {
      const image = await compressImageFile(file)
      const started = await startGeneration({
        secret: trimmed,
        name,
        prompt,
        imageBase64: image.base64,
        mimeType: image.mimeType,
      })
      window.sessionStorage.setItem(ACTIVE_JOB_STORAGE_KEY, started.operationId)
      setJob(started)
      setOperationId(started.operationId)
      if (started.status === 'failed') setError(started.error || 'Generation failed.')
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Could not start generation.')
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || job?.status === 'running' || job?.status === 'persisting'
  const form = (
    <form onSubmit={onSubmit} className="flex flex-col gap-2 whitespace-normal p-2 text-white">
      <div>
        <div className="font-mono text-sm text-white">Generate a world</div>
        <p className="mt-1 text-xs leading-relaxed text-white/60">
          Upload a photo. The server sends it to Marble and stores the world. Keys stay on the server.
        </p>
      </div>
      <label className="flex cursor-pointer flex-col gap-2 rounded border border-dashed border-white/20 bg-white/5 p-2 text-xs text-white/70">
        <span className="inline-flex items-center gap-2">
          <ImageSquareIcon size={16} />
          {file ? file.name : 'Choose a JPEG, PNG, or WebP'}
        </span>
        {previewUrl && <img src={previewUrl} alt="" className="h-24 w-full rounded object-cover" />}
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          onChange={(event) => {
            const next = event.target.files?.[0] ?? null
            setFile(next)
            setPreviewUrl((current) => {
              if (current) URL.revokeObjectURL(current)
              return next ? URL.createObjectURL(next) : null
            })
          }}
        />
      </label>
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="World name"
        maxLength={80}
        className={fieldClass}
      />
      <textarea
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="Optional prompt"
        maxLength={2000}
        rows={2}
        className={`${fieldClass} resize-none`}
      />
      <label className="flex flex-col gap-1 text-xs text-white/55">
        Gate secret
        <input
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          onBlur={() => saveSecret(secret)}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Saved in this browser"
          className={fieldClass}
        />
      </label>
      <p className="text-[11px] leading-relaxed text-white/40">
        Saved in this browser. It is sent with each request and is not an API key.
      </p>
      {(error || (job && job.status !== 'completed')) && (
        <div className="text-xs leading-relaxed text-white/75">
          {error || (job ? progressLabel(job) : null)}
        </div>
      )}
      {job?.progress && job.progress.total > 0 && job.status === 'persisting' && (
        <div className="h-1 overflow-hidden rounded bg-white/10">
          <div
            className="h-full bg-white/70"
            style={{ width: `${Math.round((job.progress.done / job.progress.total) * 100)}%` }}
          />
        </div>
      )}
      <AppButton
        type="submit"
        disabled={busy}
        className="justify-center bg-white/10 px-2 py-1.5 text-white disabled:opacity-40"
      >
        {busy ? 'Working…' : 'Start generation'}
      </AppButton>
    </form>
  )

  if (variant === 'page') {
    return (
      <div className={`${chrome.panel} w-full max-w-md`}>
        {form}
      </div>
    )
  }

  return (
    <div className={`${chrome.panel} whitespace-normal`}>
      <AppButton
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="w-full justify-between px-2 py-1.5 font-mono text-white"
      >
        <span>Generate a world</span>
        <span className="text-white/40">{open ? '–' : '+'}</span>
      </AppButton>
      {open && form}
    </div>
  )
}

const fieldClass = 'w-full rounded bg-black/40 px-2 py-1 text-xs text-white outline-none ring-1 ring-white/15 placeholder:text-white/30'

function progressLabel(job: RemoteJob): string {
  if (job.status === 'failed') return job.error || 'Generation failed.'
  if (job.status === 'completed') return 'World ready.'
  if (job.status === 'running') return 'Marble is building the world. This usually takes a few minutes.'
  const current = job.progress?.current
  const step = current === 'spz:full_res'
    ? 'environment'
    : current === 'glb'
      ? 'collider'
      : current === 'pano'
        ? 'panorama'
        : current === 'thumbnail'
          ? 'thumbnail'
          : 'files'
  const ratio = job.progress ? ` (${job.progress.done}/${job.progress.total})` : ''
  return `Saving ${step}${ratio}.`
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
