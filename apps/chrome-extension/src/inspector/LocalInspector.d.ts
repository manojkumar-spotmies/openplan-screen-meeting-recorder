import React from 'react';
import { LocalVideoChunk } from '@openplan/contracts';
/**
 * Concatenates stored 5-second WebM chunks sorted by 1-indexed sequence number
 * into a single playable Blob for developer preview and export.
 */
export declare function concatenateChunksToBlob(chunks: LocalVideoChunk[]): Blob;
export declare const LocalInspector: React.FC;
