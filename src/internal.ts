import type { App, Component, TFile } from "obsidian";

/** Parts of Obsidian's app that aren't in its public type definitions. Every use checks they exist first. */
export interface EmbedContext { containerEl: HTMLElement }
export type EmbedFactory = (ctx: EmbedContext, file: TFile) => Component;
export interface EmbedRegistry {
	registerExtension?(ext: string, factory: EmbedFactory): void;
	isExtensionRegistered?(ext: string): boolean;
	unregisterExtensions?(exts: string[]): void;
}
export interface InternalApp {
	plugins?: { disablePlugin?(id: string): Promise<void>; enablePlugin?(id: string): Promise<void> };
	setting?: { openTabById?(id: string): void };
	embedRegistry?: EmbedRegistry;
	dragManager?: { draggable?: { file?: TFile; files?: TFile[] } | null };
}
export const internal = (app: App) => app as unknown as InternalApp;

export interface VaultConfig { getConfig?(key: string): unknown; setConfig?(key: string, value: unknown): void }

export interface CanvasLike {
	posCenter?(): { x: number; y: number };
	createFileNode?(o: { file: TFile; pos: { x: number; y: number }; size: { width: number; height: number }; save: boolean; focus: boolean }): unknown;
	requestSave?(): void;
}

interface NativeImage { isEmpty(): boolean; toDataURL(): string }
interface ElectronLike {
	nativeImage?: { createThumbnailFromPath?(path: string, size: { width: number; height: number }): Promise<NativeImage> };
	webUtils?: { getPathForFile?(f: File): string };
}
/** Electron on desktop; undefined on iPad and iPhone. */
export function electron(): ElectronLike | undefined {
	try { return (window as unknown as { require?: (m: string) => ElectronLike }).require?.("electron"); } catch { return undefined; }
}

/** A Node module on desktop (fs, os); undefined on iPad and iPhone. */
export function nodeModule<T>(name: string): T | undefined {
	try { return (window as unknown as { require?: (m: string) => T }).require?.(name); } catch { return undefined; }
}
