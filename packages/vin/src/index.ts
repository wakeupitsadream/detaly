// Public API of @detaly/vin: VIN validation and the VinResolver contract; phase 1C manual VIN
// requests (docs/phase-1c-implementation.md section 6): the /vin form, the master's answer checked
// by GetSearch, the proposal (/p/<token>) and its copy into the client's cart. Catalogue resolvers
// (Laximo, acat, PartsAPI) come in phase 3.
export * from './types';
export * from './vin';
export * from './manual-resolver';
export * from './errors';
export {
  brandMatches,
  isVinPreviewSendable,
  previewVinAnswer,
  VIN_ARTICLE_MIN,
  VIN_COMMENT_MAX,
  VIN_LINE_NOTE_MAX,
  VIN_PROPOSAL_SEARCHES_MAX,
  vinLinePromisedDate,
  type VinPreviewInput,
  type VinSearch,
} from './preview';
export {
  createVinRequest,
  enqueueVinNotify,
  isUuidString,
  newVinRequestId,
  VIN_ANSWER_CHANNELS,
  VIN_NEED_TEXT_MIN,
  vinCardKey,
  vinClientKey,
  vinRequestNumber,
  type CreateVinRequestInput,
  type CreateVinRequestResult,
  type VinAnswerChannel,
  type VinConsentInput,
  type VinNotifyJob,
} from './requests';
export {
  closeVinRequest,
  isProposalToken,
  loadProposal,
  loadVinRequestForStaff,
  markVinConverted,
  newProposalToken,
  PROPOSAL_TOKEN_BYTES,
  saveVinPreview,
  sendVinProposal,
  takeVinRequest,
  VIN_ANSWER_TEXT_MAX,
  VIN_CLOSE_REASON_MAX,
  type ProposalView,
  type SendVinProposalResult,
  type VinActionRefusal,
  type VinRequestStaffView,
  type VinWorkflowDeps,
} from './workflow';
export {
  copyProposalToCart,
  PROPOSAL_TARGET_LINES_MAX,
  type CopyProposalRefusal,
  type CopyProposalResult,
} from './proposal-cart';
