/**
 * Shared types for the offline sync queue. Mirrored on the Pages Function
 * side so client and server agree on the wire format.
 */

export type SyncKind =
  | "audit"
  | "investigation"
  | "event"
  | "media_row"
  | "media_blob"
  | "transcript"
  | "sensor";

export interface SyncItem {
  id: number;
  kind: SyncKind;
  ref_id: string;
  payload_json: string;
  file_path: string | null;
  status: "pending" | "in_flight" | "done" | "failed";
  attempts: number;
  last_error: string | null;
  enqueued_at: string;
  next_attempt_at: string;
  uploaded_at: string | null;
}

export interface SyncStats {
  pending: number;
  in_flight: number;
  done: number;
  failed: number;
  oldest_pending_at: string | null;
  last_uploaded_at: string | null;
}

/**
 * Wire format sent to /api/sync/upload as the `items` JSON field.
 * For media_blob the binary file is sent as the `file` multipart field.
 */
export interface UploadItem {
  kind: SyncKind;
  ref_id: string;
  payload: Record<string, unknown>;
  /** Set for media_blob to hint server about size; bytes come via multipart. */
  byte_length?: number;
  /** Set for media_blob — server stores at this R2 key. */
  r2_key?: string;
}

export interface UploadResponse {
  accepted: string[];
  rejected: { ref_id: string; reason: string }[];
}
