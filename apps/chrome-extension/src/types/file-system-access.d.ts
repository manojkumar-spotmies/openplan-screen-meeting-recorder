// TypeScript's bundled lib.dom.d.ts already declares FileSystemDirectoryHandle,
// FileSystemFileHandle, and FileSystemWritableFileStream (from the OPFS surface), but not
// the permission methods or the showDirectoryPicker() entry point that the File System
// Access API adds on top of them. This file augments those existing global interfaces with
// just the missing pieces, instead of pulling in an extra @types package for the rest of an
// API surface we already have.
export {};

declare global {
  interface FileSystemPermissionDescriptor {
    mode?: 'read' | 'readwrite';
  }

  interface FileSystemHandle {
    queryPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
    requestPermission(descriptor?: FileSystemPermissionDescriptor): Promise<PermissionState>;
  }

  interface DirectoryPickerOptions {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?:
      | FileSystemHandle
      | 'desktop'
      | 'documents'
      | 'downloads'
      | 'music'
      | 'pictures'
      | 'videos';
  }

  interface Window {
    showDirectoryPicker(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  }
}
