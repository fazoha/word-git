import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CollabPanel } from './components/CollabPanel'
import { LeftSidebar } from './components/LeftSidebar'
import { MainDocumentArea, type RebaseSessionState } from './components/MainDocumentArea'
import { WorkflowActionPanel } from './components/WorkflowActionPanel'
import { DocumentUploadGate } from './components/DocumentUploadGate'
import { useCollaboration, type CollabPendingReview, type CollabSnapshot } from './realtime/useCollaboration'
import {
  appendSavedUpdate,
  applyOverlapResolutions,
  computeUpdateToLatest,
  getChangedSectionIds,
  mergeOfficialWithDecisions,
  submitWorkingDocumentForReview,
  updateSectionBody,
  type DocumentModel,
} from './document'

const MAX_DOCUMENTS = 3

type CollabOwnerReviewState = {
  reviewId: string
  submitterName: string
  workspaceId: string
  working: DocumentModel
}

type DocSession = {
  workingDocument: DocumentModel | null
  saveUpdateNote: string
  acceptedSectionIds: string[]
  rejectedSectionIds: string[]
  rebaseSession: RebaseSessionState | null
}

function emptySession(): DocSession {
  return {
    workingDocument: null,
    saveUpdateNote: '',
    acceptedSectionIds: [],
    rejectedSectionIds: [],
    rebaseSession: null,
  }
}

export default function App() {
  const [officialDocuments, setOfficialDocuments] = useState<DocumentModel[]>([])
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<Record<string, DocSession>>({})
  const [selectedRemovalIds, setSelectedRemovalIds] = useState<string[]>([])
  const [addMoreBusy, setAddMoreBusy] = useState(false)
  const [addMoreError, setAddMoreError] = useState<string | null>(null)
  const [collabServerUrl, setCollabServerUrl] = useState(
    () => String(import.meta.env.VITE_COLLAB_URL ?? 'http://localhost:3030'),
  )
  const [collabOwnerReview, setCollabOwnerReview] = useState<CollabOwnerReviewState | null>(null)
  const [collabRemoteAccepted, setCollabRemoteAccepted] = useState<string[]>([])
  const [collabRemoteRejected, setCollabRemoteRejected] = useState<string[]>([])
  const [editorSubmitToOwnerAckOpen, setEditorSubmitToOwnerAckOpen] = useState(false)

  const collabInRoomRef = useRef(false)
  const collabRoleRef = useRef<'owner' | 'editor' | null>(null)

  const onOfficialUpdated = useCallback((official: DocumentModel) => {
    setOfficialDocuments((prev) => {
      const i = prev.findIndex((o) => o.workspaceId === official.workspaceId)
      if (i === -1) return [official]
      const next = [...prev]
      next[i] = official
      return next
    })

    const wid = official.workspaceId
    if (!wid || !official.versionId) return
    if (!collabInRoomRef.current) return
    // Editors choose when to rebase via "Update to latest"; host stays auto-synced.
    if (collabRoleRef.current !== 'owner') return

    setSessions((prev) => {
      const s = prev[wid]
      const w = s?.workingDocument
      if (!w || w.status !== 'editing') return prev

      const { mergedSections, overlaps } = computeUpdateToLatest(official, w)
      if (overlaps.length > 0) {
        return {
          ...prev,
          [wid]: {
            ...s,
            rebaseSession: {
              overlaps,
              draftSections: mergedSections,
              resolutions: {},
            },
          },
        }
      }
      return {
        ...prev,
        [wid]: {
          ...s,
          workingDocument: {
            ...w,
            sections: mergedSections,
            basedOnVersionId: official.versionId!,
            branchBaseSections: structuredClone(official.sections),
          },
          rebaseSession: null,
        },
      }
    })
  }, [])

  const onJoinedAsEditor = useCallback((snap: CollabSnapshot & { roomId: string }) => {
    const o = snap.official
    const wid = o.workspaceId
    if (!wid) return
    setOfficialDocuments([o])
    setSessions({ [wid]: emptySession() })
    setActiveWorkspaceId(wid)
    setSelectedRemovalIds([])
    setCollabOwnerReview(null)
    setCollabRemoteAccepted([])
    setCollabRemoteRejected([])
  }, [])

  const onRoomClosed = useCallback((reason: string) => {
    setCollabOwnerReview(null)
    setCollabRemoteAccepted([])
    setCollabRemoteRejected([])
    window.alert(
      reason === 'owner_left'
        ? 'The session ended because the official owner left.'
        : 'The collaboration session ended.',
    )
  }, [])

  const collab = useCollaboration({
    serverUrl: collabServerUrl,
    onOfficialUpdated,
    onJoinedAsEditor,
    onRoomClosed,
  })

  collabInRoomRef.current = collab.status === 'in_room'
  collabRoleRef.current = collab.role

  const officialDocument = useMemo(
    () => officialDocuments.find((o) => o.workspaceId === activeWorkspaceId) ?? null,
    [officialDocuments, activeWorkspaceId],
  )

  const session = activeWorkspaceId
    ? (sessions[activeWorkspaceId] ?? emptySession())
    : emptySession()

  const workingDocument = session.workingDocument
  const saveUpdateNote = session.saveUpdateNote
  const acceptedSectionIds = session.acceptedSectionIds
  const rejectedSectionIds = session.rejectedSectionIds
  const rebaseSession = session.rebaseSession

  const workingStatus = workingDocument?.status

  const patchSession = useCallback((workspaceId: string, patch: Partial<DocSession>) => {
    setSessions((prev) => ({
      ...prev,
      [workspaceId]: { ...(prev[workspaceId] ?? emptySession()), ...patch },
    }))
  }, [])

  const isWorkingCopy = workingDocument !== null

  const activeDocument: DocumentModel | null =
    officialDocument === null ? null : isWorkingCopy ? workingDocument! : officialDocument

  const rebaseOpen = rebaseSession !== null
  const documentReadOnly = !isWorkingCopy || workingStatus === 'in_review' || rebaseOpen

  const isOfficialNewerThanBranch =
    officialDocument !== null &&
    isWorkingCopy &&
    workingStatus === 'editing' &&
    workingDocument!.basedOnVersionId !== undefined &&
    officialDocument.versionId !== undefined &&
    workingDocument!.basedOnVersionId !== officialDocument.versionId

  const changedSectionIds =
    isWorkingCopy && workingDocument && officialDocument
      ? getChangedSectionIds(officialDocument, workingDocument)
      : []

  const allChangedSectionsDecided =
    changedSectionIds.length === 0 ||
    changedSectionIds.every(
      (id) => acceptedSectionIds.includes(id) || rejectedSectionIds.includes(id),
    )

  const collabReviewChangedIds =
    collabOwnerReview && officialDocument
      ? getChangedSectionIds(officialDocument, collabOwnerReview.working)
      : []
  const allCollabReviewDecided =
    collabReviewChangedIds.length === 0 ||
    collabReviewChangedIds.every(
      (id) => collabRemoteAccepted.includes(id) || collabRemoteRejected.includes(id),
    )

  const handleStartCollabReview = useCallback((r: CollabPendingReview) => {
    setActiveWorkspaceId(r.workspaceId)
    setCollabOwnerReview({
      reviewId: r.id,
      submitterName: r.fromName,
      workspaceId: r.workspaceId,
      working: r.workingDocument,
    })
    setCollabRemoteAccepted([])
    setCollabRemoteRejected([])
  }, [])

  const collabOwnerInRoom = collab.role === 'owner' && collab.status === 'in_room'

  /** Host edits the shared official via a working copy without clicking “Start working”. */
  useEffect(() => {
    if (!collabOwnerInRoom || collabOwnerReview) return
    if (!activeWorkspaceId || !officialDocument?.workspaceId || !officialDocument.versionId) return

    setSessions((prev) => {
      const s = prev[activeWorkspaceId]
      if (s?.workingDocument) return prev
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...(s ?? emptySession()),
          workingDocument: {
            sections: structuredClone(officialDocument.sections),
            savedUpdates: [],
            status: 'editing',
            reviewRequests: [],
            basedOnVersionId: officialDocument.versionId!,
            branchBaseSections: structuredClone(officialDocument.sections),
            documentTitle: officialDocument.documentTitle,
            workspaceId: officialDocument.workspaceId,
          },
          acceptedSectionIds: [],
          rejectedSectionIds: [],
          rebaseSession: null,
        },
      }
    })
  }, [collabOwnerInRoom, collabOwnerReview, activeWorkspaceId, officialDocument])

  function handleFirstDocumentLoaded(doc: DocumentModel) {
    const wid = doc.workspaceId
    if (!wid) return
    setOfficialDocuments([doc])
    setSessions({ [wid]: emptySession() })
    setActiveWorkspaceId(wid)
    setSelectedRemovalIds([])
  }

  async function handleAddDocumentFile(file: File) {
    if (officialDocuments.length >= MAX_DOCUMENTS) return
    setAddMoreError(null)
    setAddMoreBusy(true)
    try {
      const { importDocxFromFile } = await import('./docxImport')
      const doc = await importDocxFromFile(file)
      const wid = doc.workspaceId
      if (!wid) return
      setOfficialDocuments((prev) => [...prev, doc])
      setSessions((prev) => ({ ...prev, [wid]: emptySession() }))
      setActiveWorkspaceId(wid)
      setSelectedRemovalIds([])
    } catch (e) {
      setAddMoreError(e instanceof Error ? e.message : 'Could not read this file.')
    } finally {
      setAddMoreBusy(false)
    }
  }

  function handleToggleRemoval(workspaceId: string) {
    setSelectedRemovalIds((prev) =>
      prev.includes(workspaceId) ? prev.filter((x) => x !== workspaceId) : [...prev, workspaceId],
    )
  }

  function handleRemoveSelected() {
    const ids = selectedRemovalIds
    if (ids.length === 0) return
    setOfficialDocuments((prev) => {
      const next = prev.filter((o) => !o.workspaceId || !ids.includes(o.workspaceId))
      setActiveWorkspaceId((cur) => {
        if (!cur || !ids.includes(cur)) return cur
        return next[0]?.workspaceId ?? null
      })
      return next
    })
    setSessions((prev) => {
      const n = { ...prev }
      ids.forEach((id) => {
        delete n[id]
      })
      return n
    })
    setSelectedRemovalIds([])
  }

  function handleStartWorking() {
    if (!activeWorkspaceId || !officialDocument || isWorkingCopy) return
    patchSession(activeWorkspaceId, {
      workingDocument: {
        sections: structuredClone(officialDocument.sections),
        savedUpdates: [],
        status: 'editing',
        reviewRequests: [],
        basedOnVersionId: officialDocument.versionId!,
        branchBaseSections: structuredClone(officialDocument.sections),
        documentTitle: officialDocument.documentTitle,
        workspaceId: officialDocument.workspaceId,
      },
      acceptedSectionIds: [],
      rejectedSectionIds: [],
      rebaseSession: null,
    })
  }

  function handleSectionBodyChange(sectionId: string, body: string) {
    if (!activeWorkspaceId) return
    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      if (!s.workingDocument) return prev
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          workingDocument: updateSectionBody(s.workingDocument, sectionId, body),
        },
      }
    })
  }

  function handleSaveUpdate() {
    if (!activeWorkspaceId) return
    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      if (!s.workingDocument) return prev
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          workingDocument: appendSavedUpdate(s.workingDocument, s.saveUpdateNote),
          saveUpdateNote: '',
        },
      }
    })
  }

  function handleSendForReview() {
    if (!activeWorkspaceId) return
    const isCollabEditor = collab.role === 'editor' && collab.status === 'in_room'

    if (isCollabEditor) {
      const s = sessions[activeWorkspaceId] ?? emptySession()
      if (!s.workingDocument || s.workingDocument.status !== 'editing') return
      const nextWorking = submitWorkingDocumentForReview(structuredClone(s.workingDocument))
      collab.submitReview(activeWorkspaceId, nextWorking)
      setEditorSubmitToOwnerAckOpen(true)
      setSessions((prev) => {
        const cur = prev[activeWorkspaceId] ?? emptySession()
        if (!cur.workingDocument || cur.workingDocument.status !== 'editing') return prev
        return {
          ...prev,
          [activeWorkspaceId]: {
            ...cur,
            workingDocument: null,
            saveUpdateNote: '',
            acceptedSectionIds: [],
            rejectedSectionIds: [],
            rebaseSession: null,
          },
        }
      })
      return
    }

    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      if (!s.workingDocument || s.workingDocument.status !== 'editing') return prev
      const nextWorking = submitWorkingDocumentForReview(structuredClone(s.workingDocument))
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          workingDocument: nextWorking,
          acceptedSectionIds: [],
          rejectedSectionIds: [],
          rebaseSession: null,
        },
      }
    })
  }

  function handleAcceptSection(sectionId: string) {
    if (!activeWorkspaceId) return
    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          rejectedSectionIds: s.rejectedSectionIds.filter((id) => id !== sectionId),
          acceptedSectionIds: s.acceptedSectionIds.includes(sectionId)
            ? s.acceptedSectionIds
            : [...s.acceptedSectionIds, sectionId],
        },
      }
    })
  }

  function handleRejectSection(sectionId: string) {
    if (!activeWorkspaceId) return
    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          acceptedSectionIds: s.acceptedSectionIds.filter((id) => id !== sectionId),
          rejectedSectionIds: s.rejectedSectionIds.includes(sectionId)
            ? s.rejectedSectionIds
            : [...s.rejectedSectionIds, sectionId],
        },
      }
    })
  }

  function handleMakeOfficial() {
    if (!activeWorkspaceId || !officialDocument) return
    if (collab.role === 'editor' && collab.status === 'in_room') return

    if (collabOwnerReview) {
      if (activeWorkspaceId !== collabOwnerReview.workspaceId) return
      if (!allCollabReviewDecided) return
      const merged = mergeOfficialWithDecisions(
        officialDocument,
        collabOwnerReview.working,
        new Set(collabRemoteAccepted),
      )
      setOfficialDocuments((prev) =>
        prev.map((o) => (o.workspaceId === activeWorkspaceId ? merged : o)),
      )
      collab.resolveReview(collabOwnerReview.reviewId, merged)
      setCollabOwnerReview(null)
      setCollabRemoteAccepted([])
      setCollabRemoteRejected([])
      return
    }

    if (
      collabOwnerInRoom &&
      workingDocument &&
      workingStatus === 'editing' &&
      officialDocument
    ) {
      const toPublish = getChangedSectionIds(officialDocument, workingDocument)
      if (toPublish.length === 0) return
      const merged = mergeOfficialWithDecisions(
        officialDocument,
        workingDocument,
        new Set(toPublish),
      )
      setOfficialDocuments((prev) =>
        prev.map((o) => (o.workspaceId === activeWorkspaceId ? merged : o)),
      )
      patchSession(activeWorkspaceId, {
        workingDocument: null,
        saveUpdateNote: '',
        acceptedSectionIds: [],
        rejectedSectionIds: [],
        rebaseSession: null,
      })
      collab.pushOfficial(merged)
      return
    }

    if (!workingDocument || workingStatus !== 'in_review') return
    if (!allChangedSectionsDecided) return

    const merged = mergeOfficialWithDecisions(officialDocument, workingDocument, new Set(acceptedSectionIds))
    setOfficialDocuments((prev) =>
      prev.map((o) => (o.workspaceId === activeWorkspaceId ? merged : o)),
    )
    patchSession(activeWorkspaceId, {
      workingDocument: null,
      saveUpdateNote: '',
      acceptedSectionIds: [],
      rejectedSectionIds: [],
      rebaseSession: null,
    })
    if (collab.role === 'owner' && collab.status === 'in_room') {
      collab.pushOfficial(merged)
    }
  }

  function handleUpdateToLatest() {
    if (!activeWorkspaceId || !officialDocument || !workingDocument || workingStatus !== 'editing') return
    if (workingDocument.basedOnVersionId === officialDocument.versionId) return

    const { mergedSections, overlaps } = computeUpdateToLatest(officialDocument, workingDocument)

    if (overlaps.length === 0) {
      patchSession(activeWorkspaceId, {
        workingDocument: {
          ...workingDocument,
          sections: mergedSections,
          basedOnVersionId: officialDocument.versionId!,
          branchBaseSections: structuredClone(officialDocument.sections),
        },
        rebaseSession: null,
      })
      return
    }

    patchSession(activeWorkspaceId, {
      rebaseSession: {
        overlaps,
        draftSections: mergedSections,
        resolutions: {},
      },
    })
  }

  function handleRebaseChoose(sectionId: string, choice: 'official' | 'mine') {
    if (!activeWorkspaceId) return
    setSessions((prev) => {
      const s = prev[activeWorkspaceId] ?? emptySession()
      if (!s.rebaseSession) return prev
      return {
        ...prev,
        [activeWorkspaceId]: {
          ...s,
          rebaseSession: {
            ...s.rebaseSession,
            resolutions: { ...s.rebaseSession.resolutions, [sectionId]: choice },
          },
        },
      }
    })
  }

  function handleApplyRebaseMerge() {
    if (!activeWorkspaceId || !rebaseSession || !workingDocument) return
    const { overlaps, draftSections, resolutions } = rebaseSession
    const allChosen = overlaps.every((o) => resolutions[o.sectionId] !== undefined)
    if (!allChosen || !officialDocument) return

    const finalSections = applyOverlapResolutions(
      draftSections,
      overlaps,
      resolutions as Record<string, 'official' | 'mine'>,
    )

    patchSession(activeWorkspaceId, {
      workingDocument: {
        ...workingDocument,
        sections: finalSections,
        basedOnVersionId: officialDocument.versionId!,
        branchBaseSections: structuredClone(officialDocument.sections),
      },
      rebaseSession: null,
    })
  }

  if (officialDocuments.length === 0) {
    return (
      <div className="flex h-screen min-h-0 bg-white font-sans text-gray-800 antialiased">
        <LeftSidebar />
        <DocumentUploadGate
          onDocumentLoaded={handleFirstDocumentLoaded}
          joinCollaboration={{
            serverUrl: collabServerUrl,
            onServerUrlChange: setCollabServerUrl,
            onJoinRoom: (code, displayName) => collab.joinRoom(code, displayName),
            connecting: collab.status === 'connecting',
            error: collab.error,
            onClearError: collab.clearError,
          }}
        />
      </div>
    )
  }

  if (!officialDocument || !activeDocument) {
    return (
      <div className="flex h-screen min-h-0 bg-white font-sans text-gray-800 antialiased">
        <LeftSidebar />
        <div className="flex flex-1 items-center justify-center text-sm text-gray-600">
          Select a document in the panel.
        </div>
      </div>
    )
  }

  const collabEditorInRoom = collab.role === 'editor' && collab.status === 'in_room'
  const collabOwnerHasUnpublishedEdits =
    collabOwnerInRoom &&
    isWorkingCopy &&
    workingStatus === 'editing' &&
    changedSectionIds.length > 0

  return (
    <div className="flex h-screen min-h-0 bg-white font-sans text-gray-800 antialiased">
      {editorSubmitToOwnerAckOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="editor-submit-ack-title"
        >
          <div className="max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
            <h2 id="editor-submit-ack-title" className="text-lg font-semibold text-gray-900">
              Sent to the owner
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-gray-600">
              Your version has been sent to the owner of this document. They will review your changes and can merge them into
              the official version. You will see updates when the shared document changes.
            </p>
            <button
              type="button"
              onClick={() => setEditorSubmitToOwnerAckOpen(false)}
              className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700"
            >
              OK
            </button>
          </div>
        </div>
      ) : null}
      <LeftSidebar />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex min-h-0 flex-1">
          <MainDocumentArea
            officialDocument={officialDocument}
            activeDocument={activeDocument}
            isWorkingCopy={isWorkingCopy}
            workingStatus={workingStatus}
            readOnly={documentReadOnly}
            onSectionBodyChange={handleSectionBodyChange}
            acceptedSectionIds={acceptedSectionIds}
            rejectedSectionIds={rejectedSectionIds}
            onAcceptSection={handleAcceptSection}
            onRejectSection={handleRejectSection}
            isOfficialNewerThanBranch={Boolean(isOfficialNewerThanBranch)}
            onUpdateToLatest={handleUpdateToLatest}
            rebaseSession={rebaseSession}
            onRebaseChoose={handleRebaseChoose}
            onApplyRebaseMerge={handleApplyRebaseMerge}
            collabOwnerReview={
              collabOwnerReview && officialDocument
                ? {
                    submitterName: collabOwnerReview.submitterName,
                    submittedDocument: collabOwnerReview.working,
                    acceptedSectionIds: collabRemoteAccepted,
                    rejectedSectionIds: collabRemoteRejected,
                    onAcceptSection: (sectionId: string) => {
                      setCollabRemoteRejected((p) => p.filter((id) => id !== sectionId))
                      setCollabRemoteAccepted((p) =>
                        p.includes(sectionId) ? p : [...p, sectionId],
                      )
                    },
                    onRejectSection: (sectionId: string) => {
                      setCollabRemoteAccepted((p) => p.filter((id) => id !== sectionId))
                      setCollabRemoteRejected((p) =>
                        p.includes(sectionId) ? p : [...p, sectionId],
                      )
                    },
                  }
                : null
            }
            coauthorApiBaseUrl={collabServerUrl}
          />
          <WorkflowActionPanel
            documents={officialDocuments}
            activeWorkspaceId={activeWorkspaceId!}
            maxDocuments={MAX_DOCUMENTS}
            selectedRemovalIds={selectedRemovalIds}
            onToggleRemoval={handleToggleRemoval}
            onSelectWorkspace={setActiveWorkspaceId}
            onAddDocumentFile={handleAddDocumentFile}
            addMoreBusy={addMoreBusy}
            addMoreError={addMoreError}
            onDismissAddMoreError={() => setAddMoreError(null)}
            onRemoveSelected={handleRemoveSelected}
            isWorkingCopy={isWorkingCopy}
            workingStatus={workingStatus}
            saveUpdateNote={saveUpdateNote}
            onSaveUpdateNoteChange={(value) => {
              if (activeWorkspaceId) patchSession(activeWorkspaceId, { saveUpdateNote: value })
            }}
            onStartWorking={handleStartWorking}
            onSaveUpdate={handleSaveUpdate}
            onSendForReview={handleSendForReview}
            onMakeOfficial={handleMakeOfficial}
            canMakeOfficial={
              collabOwnerReview
                ? allCollabReviewDecided
                : collabOwnerHasUnpublishedEdits
                  ? true
                  : workingStatus === 'in_review' && allChangedSectionsDecided
            }
            hideMakeOfficial={collabEditorInRoom}
            collabOwnerReviewActive={Boolean(collabOwnerReview)}
            collabOwnerInRoom={collabOwnerInRoom}
            collabOwnerHasUnpublishedEdits={collabOwnerHasUnpublishedEdits}
            collabSection={
              <CollabPanel
                serverUrl={collabServerUrl}
                onServerUrlChange={setCollabServerUrl}
                canCreateRoom={Boolean(officialDocument)}
                officialForRoom={officialDocument}
                status={collab.status}
                error={collab.error}
                onClearError={collab.clearError}
                roomId={collab.roomId}
                role={collab.role}
                members={collab.members}
                pendingReviews={collab.pendingReviews}
                onCreateRoom={(displayName) => {
                  if (officialDocument) collab.createRoom(displayName, officialDocument)
                }}
                onJoinRoom={collab.joinRoom}
                onDisconnect={() => {
                  collab.disconnectCollab()
                  setCollabOwnerReview(null)
                  setCollabRemoteAccepted([])
                  setCollabRemoteRejected([])
                }}
                onStartReview={handleStartCollabReview}
                activeRemoteReviewId={collabOwnerReview?.reviewId ?? null}
                onCancelRemoteReview={() => {
                  setCollabOwnerReview(null)
                  setCollabRemoteAccepted([])
                  setCollabRemoteRejected([])
                }}
                onSubmitToOwner={handleSendForReview}
                editorSubmitToOwnerEnabled={
                  collab.role === 'editor' &&
                  collab.status === 'in_room' &&
                  isWorkingCopy &&
                  workingStatus === 'editing'
                }
              />
            }
            collabEditorInRoom={collabEditorInRoom}
            onUpdateToLatest={handleUpdateToLatest}
            showUpdateToLatest={Boolean(isOfficialNewerThanBranch) && !rebaseOpen}
            savedUpdates={workingDocument?.savedUpdates ?? []}
            reviewRequests={workingDocument?.reviewRequests ?? []}
          />
        </div>
      </div>
    </div>
  )
}
