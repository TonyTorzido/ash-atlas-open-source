import {
  distanceMeters,
  travelHungerCost,
  type PlayerAppearanceSnapshot,
  type LatLon,
  type WorldMapSocialAudience,
  type WorldEnvironmentOverlayGroupId,
  type WorldMapDestination,
  type WorldMapDestinationSnapshot,
  type WorldMapSocialVisibility
} from "@ash-atlas/shared";
import maplibregl from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import cityMarkerUrl from "../assets/city-marker.png";
import kingdomSeatMarkerUrl from "../assets/kingdom-seat-marker.png";
import manorMarkerUrl from "../assets/manor-marker.png";
import atlasShrineMarkerUrl from "../assets/structures/atlas-shrine.png";
import {
  createWorldMap,
  type WorldMapInstance
} from "../map/worldMap.js";
import {
  planGlobeMapRecenter,
  worldMapRecenterTargetZoom
} from "../map/globeCamera.js";
import {
  createDefaultWorldEnvironmentOverlaySelections,
  installWorldEnvironmentOverlays,
  setWorldEnvironmentOverlayCategory,
  type WorldEnvironmentOverlayPresenter
} from "../map/worldEnvironmentOverlays.js";
import {
  fixedWorldPngDimensions,
  WORLD_PNG_PRESENTATION,
  type FixedWorldPngPresentation
} from "../map/worldPngPresentation.js";
import {
  clusterWorldMapDestinations
} from "../map/worldMapDestinationLayout.js";
import {
  isWorldMapTravelActive,
  WORLD_MAP_ARRIVAL_MS,
  type WorldMapTravelState
} from "../features/travel/worldMapTravelModel.js";
import {
  worldMapTravelArrivalZoom,
  worldMapTravelIntroCamera,
  worldMapTravelIntroMs
} from "../map/travelCamera.js";
import {
  bindGlobeMarkerOcclusion,
  isSurfacePointOnNearSide,
  mapGlobeCamera
} from "../map/globeMarkerOcclusion.js";
import { requestMobileMenuReturnToGame } from "../mobileGameMenu.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";
import { GameAppFooter, GameAppHeader, GameAppTabs } from "./GameAppShell.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { GameTargetPicker } from "./GameTargetPicker.js";
import { RealmAppTabs, type RealmAppSection } from "./RealmAppTabs.js";
import { useModalBehavior } from "./useModalBehavior.js";
import {
  HUB_GLYPH_PATH,
  readStoredWorldMapView,
  storeWorldMapView,
  WorldMapDestinationList,
  type WorldMapView
} from "./WorldMapDestinationList.js";
import { WorldMapLayerControl } from "./WorldMapLayerControl.js";
import { WorldZoneReadout, type WorldZoneReadoutView } from "./WorldZoneBanner.js";
import { compareWorldMapDestinations } from "./worldMapDestinationPresentation.js";
import {
  createWorldMapPlayerMarkerElement,
  WORLD_MAP_REMOTE_PLAYER_SCALE,
  type WorldMapPlayerMarkerElement
} from "./worldMapPlayerMarker.js";

type Props = {
  /** Relocate your standing position (24h cooldown); shown as a header action. */
  relocateAction?: Readonly<{ label: string; enabled: boolean; disabledReason?: string | null; onSelect(): void }> | undefined;
  open: boolean;
  snapshot: WorldMapDestinationSnapshot | null;
  /** The zone under the player; hidden when the lookup or position is unavailable. */
  zoneReadout?: WorldZoneReadoutView | null;
  fallbackCenter: { lat: number; lon: number };
  displayColor?: string | null;
  appearance?: PlayerAppearanceSnapshot;
  connectionStatus?: "offline" | "connecting" | "online";
  travelState?: WorldMapTravelState;
  travelDisabled: boolean;
  autoTravelDestination?: Readonly<{
    kind: "atlas_shrine";
    id: string;
  }> | null;
  developerAccessEnabled: boolean;
  developerMenuOpen: boolean;
  teleportMode: "idle" | "targeting" | "pending";
  pngMasterScale?: number;
  closeLabel?: string;
  layout?: "desktop" | "phone";
  onClose(): void;
  onTravel(destination: WorldMapDestination): string | null;
  onAutoTravelStarted?(): void;
  onCancelTravel?(): void;
  onPresentationComplete?(requestId: string): void;
  onArrivalComplete?(): void;
  onOpenDeveloperTools(): void;
  onOpenRealmSection?(section: RealmAppSection): void;
  onTeleportTarget(lat: number, lon: number): void;
  onCancelTeleport(): void;
  onSetDestinationVisibility?(
    destination: Pick<WorldMapDestination, "kind" | "id">,
    visible: boolean
  ): boolean;
  onSetSocialVisibility?(audience: WorldMapSocialAudience, visible: boolean): boolean;
  /** Compass overview: the player's own Map Markers (empty without a Compass). */
  mapMarkers?: readonly Readonly<{ id: string; name: string; lat: number; lon: number }>[];
  /** Deepstone Lore cave landmarks (view-only). */
  caves?: readonly Readonly<{ id: string; name: string; lat: number; lon: number }>[];
  activeWaypointMarkerId?: string | null;
  onOpenMapMarkers?(): void;
};

export function WorldMapOverlay({
  relocateAction,
  open,
  snapshot,
  zoneReadout = null,
  fallbackCenter,
  displayColor = null,
  appearance,
  connectionStatus = "online",
  travelState = { phase: "idle" },
  travelDisabled,
  autoTravelDestination = null,
  developerAccessEnabled,
  developerMenuOpen,
  teleportMode,
  pngMasterScale,
  layout = "desktop",
  onClose,
  onTravel,
  onAutoTravelStarted = () => undefined,
  onCancelTravel = () => undefined,
  onPresentationComplete = () => undefined,
  onArrivalComplete = () => undefined,
  onOpenDeveloperTools,
  onOpenRealmSection,
  onTeleportTarget,
  onCancelTeleport,
  onSetDestinationVisibility = () => false,
  onSetSocialVisibility = () => false,
  mapMarkers = [],
  caves = [],
  activeWaypointMarkerId = null,
  onOpenMapMarkers
}: Props): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null);
  const instanceRef = useRef<WorldMapInstance | null>(null);
  const environmentOverlayPresenterRef = useRef<WorldEnvironmentOverlayPresenter | null>(null);
  const markersRef = useRef<maplibregl.Marker[]>([]);
  const socialMarkersRef = useRef<maplibregl.Marker[]>([]);
  const socialMarkerElementsRef = useRef<WorldMapPlayerMarkerElement[]>([]);
  const playerMarkerRef = useRef<maplibregl.Marker | null>(null);
  const travelMarkerRef = useRef<maplibregl.Marker | null>(null);
  const viewRef = useRef<WorldMapView>("list");
  const playerMarkerElementRef = useRef<WorldMapPlayerMarkerElement | null>(null);
  const travelStateRef = useRef(travelState);
  const onPresentationCompleteRef = useRef(onPresentationComplete);
  const remainingSecondRef = useRef(-1);
  const travelRequestGateRef = useRef(false);
  const autoTravelStartedRef = useRef<string | null>(null);
  const currentOpenRef = useRef(open);
  const currentLayoutRef = useRef(layout);
  const preservedCameraRef = useRef<Readonly<{
    center: [number, number];
    zoom: number;
  }> | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapRevision, setMapRevision] = useState(0);
  const [markerLayoutRevision, setMarkerLayoutRevision] = useState(0);
  const [routeLayoutRevision, setRouteLayoutRevision] = useState(0);
  const [clusterPickerId, setClusterPickerId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [travelRequested, setTravelRequested] = useState(false);
  const [remainingMs, setRemainingMs] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [layerMenuOpen, setLayerMenuOpen] = useState(false);
  const [socialMenuOpen, setSocialMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [view, setView] = useState<WorldMapView>(readStoredWorldMapView);
  const [activeLayerPanelId, setActiveLayerPanelId] =
    useState<WorldEnvironmentOverlayGroupId>("environment");
  const [activeOverlayGroupId, setActiveOverlayGroupId] =
    useState<WorldEnvironmentOverlayGroupId | null>("environment");
  const [overlaySelections, setOverlaySelections] = useState(
    createDefaultWorldEnvironmentOverlaySelections
  );
  const [socialVisibilityDraft, setSocialVisibilityDraft] =
    useState<WorldMapSocialVisibility>(() => defaultWorldMapSocialVisibility());
  currentOpenRef.current = open;
  currentLayoutRef.current = layout;
  const [overlayError, setOverlayError] = useState<string | null>(null);
  const destinations = useMemo(() => snapshot?.destinations ?? [], [snapshot]);
  const selected = useMemo(
    () => destinations.find((destination) => destinationKey(destination) === selectedId) ?? null,
    [destinations, selectedId]
  );
  const clusterPickerDestinations = useMemo(() => {
    if (!clusterPickerId) return [];
    const keys = new Set(clusterPickerId.split("|"));
    return destinations.filter((destination) =>
      destination.visible !== false && keys.has(destinationKey(destination))
    );
  }, [clusterPickerId, destinations]);
  const mapDestinations = useMemo(() => destinations.filter((destination) =>
    destination.visible !== false || destinationKey(destination) === selectedId
  ), [destinations, selectedId]);
  const travelActive = isWorldMapTravelActive(travelState);
  const travelControlDisabled = travelDisabled || teleportMode !== "idle";
  const activeRequestId = travelActive ? travelState.requestId : null;
  // The travel animation plays on the globe, so a trip always reveals it.
  viewRef.current = view;
  const listView = view === "list" && !travelActive && teleportMode === "idle";
  travelStateRef.current = travelState;
  onPresentationCompleteRef.current = onPresentationComplete;

  useEffect(() => {
    if (!open) return;
    setLayerMenuOpen(false);
    setSocialMenuOpen(false);
    setSearchOpen(false);
    setActiveLayerPanelId("environment");
    setActiveOverlayGroupId("environment");
    setOverlaySelections(createDefaultWorldEnvironmentOverlaySelections());
    setOverlayError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSocialVisibilityDraft(
      snapshot?.socialVisibility ?? defaultWorldMapSocialVisibility()
    );
  }, [open, snapshot?.socialVisibility]);

  useEffect(() => {
    if (!open || listView) return;
    const map = instanceRef.current?.map;
    if (!map) return;
    map.resize();
    map.triggerRepaint();
  }, [listView, mapRevision, open]);

  useEffect(() => {
    if (!open || !travelActive) {
      travelRequestGateRef.current = false;
      setTravelRequested(false);
    }
  }, [open, travelActive]);

  useEffect(() => {
    if (!autoTravelDestination) {
      autoTravelStartedRef.current = null;
      return;
    }
    if (
      !open ||
      travelControlDisabled ||
      travelActive ||
      travelRequestGateRef.current ||
      autoTravelStartedRef.current === autoTravelDestination.id
    ) {
      return;
    }
    const destination = destinations.find(
      (candidate) =>
        candidate.kind === autoTravelDestination.kind &&
        candidate.id === autoTravelDestination.id
    );
    if (!destination) return;
    const requestId = onTravel(destination);
    if (!requestId) return;
    autoTravelStartedRef.current = autoTravelDestination.id;
    onAutoTravelStarted();
  }, [
    autoTravelDestination,
    destinations,
    onAutoTravelStarted,
    onTravel,
    open,
    travelActive,
    travelControlDisabled
  ]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = (): void => setReducedMotion(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    const instance = createWorldMap(containerRef.current, fallbackCenter);
    instanceRef.current = instance;
    let markersInstalled = false;
    const installMarkers = (): void => {
      if (markersInstalled) return;
      markersInstalled = true;
      const preservedCamera = preservedCameraRef.current;
      if (preservedCamera) {
        instance.map.jumpTo(preservedCamera);
        preservedCameraRef.current = null;
      }
      setMapReady(true);
      setMapRevision((current) => current + 1);
    };
    void instance.map.once("render", installMarkers);
    instance.map.triggerRepaint();
    return () => {
      if (currentOpenRef.current && currentLayoutRef.current !== layout) {
        const center = instance.map.getCenter();
        preservedCameraRef.current = {
          center: [center.lng, center.lat],
          zoom: instance.map.getZoom()
        };
      } else {
        preservedCameraRef.current = null;
      }
      instance.map.off("render", installMarkers);
      for (const marker of markersRef.current) marker.remove();
      markersRef.current = [];
      for (const marker of socialMarkersRef.current) marker.remove();
      socialMarkersRef.current = [];
      for (const element of socialMarkerElementsRef.current) element.destroy();
      socialMarkerElementsRef.current = [];
      playerMarkerRef.current?.remove();
      playerMarkerRef.current = null;
      playerMarkerElementRef.current = null;
      environmentOverlayPresenterRef.current?.destroy();
      environmentOverlayPresenterRef.current = null;
      instance.map.remove();
      instanceRef.current = null;
      setMapReady(false);
      setClusterPickerId(null);
    };
  }, [layout, open]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    const presenter = installWorldEnvironmentOverlays(map, (label) => {
      setOverlayError(`${label} could not be loaded. The World Map remains available.`);
    });
    environmentOverlayPresenterRef.current = presenter;
    return () => {
      if (environmentOverlayPresenterRef.current === presenter) {
        presenter.destroy();
        environmentOverlayPresenterRef.current = null;
      }
    };
  }, [mapReady, mapRevision]);

  useEffect(() => {
    environmentOverlayPresenterRef.current?.sync(
      activeOverlayGroupId,
      activeOverlayGroupId ? overlaySelections[activeOverlayGroupId] ?? [] : []
    );
  }, [activeOverlayGroupId, mapReady, mapRevision, overlaySelections]);

  useEffect(() => {
    if (!open || layout !== "phone" || !containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      instanceRef.current?.map.resize();
      setRouteLayoutRevision((current) => current + 1);
    });
    observer.observe(containerRef.current);
    const resizeFrame = requestAnimationFrame(() => instanceRef.current?.map.resize());
    return () => {
      cancelAnimationFrame(resizeFrame);
      observer.disconnect();
    };
  }, [layout, open]);

  useEffect(() => {
    setSelectedId((current) =>
      current && destinations.some((destination) => destinationKey(destination) === current)
        ? current
        : null
    );
  }, [destinations]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    const element = createWorldMapPlayerMarkerElement(displayColor, appearance);
    const currentTravelState = travelStateRef.current;
    const initialPosition = currentTravelState.phase === "idle"
      ? fallbackCenter
      : currentTravelState.origin;
    const marker = new maplibregl.Marker({
      element: element.outer,
      anchor: "bottom",
      opacityWhenCovered: 1
    })
      .setLngLat([initialPosition.lon, initialPosition.lat])
      .addTo(map);
    playerMarkerRef.current = marker;
    playerMarkerElementRef.current = element;
    applyPlayerMarkerState(element, travelStateRef.current, reducedMotion);
    return () => {
      marker.remove();
      element.destroy();
      if (playerMarkerRef.current === marker) playerMarkerRef.current = null;
      if (playerMarkerElementRef.current === element) {
        playerMarkerElementRef.current = null;
      }
    };
  }, [appearance?.revision, displayColor, mapReady, mapRevision]);

  useEffect(() => {
    if (travelActive) return;
    const position = travelState.phase === "failed"
      ? travelState.origin
      : fallbackCenter;
    playerMarkerRef.current?.setLngLat([position.lon, position.lat]);
  }, [
    fallbackCenter.lat,
    fallbackCenter.lon,
    travelActive,
    travelState
  ]);

  useEffect(() => {
    const element = playerMarkerElementRef.current;
    if (!element) return;
    applyPlayerMarkerState(element, travelState, reducedMotion);
  }, [reducedMotion, travelState.phase]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    const container = containerRef.current;
    const currentState = travelStateRef.current;
    if (
      !map ||
      !container ||
      !mapReady ||
      !activeRequestId ||
      !isWorldMapTravelActive(currentState)
    ) return;

    const session = currentState;
    // Intro: fly to a camera that frames the whole route before the line animates. The
    // trip itself stays timed from startedAtMs (server authority); the intro only
    // delays the visual progress and is capped well below the trip duration.
    const introMs = worldMapTravelIntroMs(session.durationMs, reducedMotion);
    const introCamera = worldMapTravelIntroCamera(
      session.origin,
      session.destination,
      container.clientWidth,
      container.clientHeight
    );
    map.stop();
    if (viewRef.current === "list") {
      // Coming from the list view: appear already centred on the player.
      map.jumpTo({ center: [session.origin.lon, session.origin.lat], zoom: introCamera.zoom });
    }
    if (introMs > 0) {
      // flyTo arcs out and back in when the camera starts far from the route.
      map.flyTo({
        center: [introCamera.center.lon, introCamera.center.lat],
        zoom: introCamera.zoom,
        bearing: 0,
        pitch: 0,
        duration: introMs,
        essential: true
      });
    } else {
      map.jumpTo({ center: [introCamera.center.lon, introCamera.center.lat], zoom: introCamera.zoom });
    }
    const initialRemainingMs = Math.max(
      0,
      session.durationMs - (performance.now() - session.startedAtMs)
    );
    remainingSecondRef.current = Math.ceil(initialRemainingMs / 1_000);
    setRemainingMs(initialRemainingMs);
    const route = createTravelRouteElement(container);
    const destinationPulse = createDestinationPulseElement();
    const destinationMarker = new maplibregl.Marker({
      element: destinationPulse,
      anchor: "center",
      opacityWhenCovered: 1
    })
      .setLngLat([session.destination.lon, session.destination.lat])
      .addTo(map);
    travelMarkerRef.current = destinationMarker;
    setWorldMapInteractionLocked(map, true);
    let frameId: number | null = null;
    let presentationReported = false;

    const renderFrame = (now: number): void => {
      const routeMs = session.durationMs - introMs;
      // Frame timestamps are fractional; snap floating-point rounding (1e-6 ms) so
      // error in (now - startedAtMs) can never leave the route stuck just short of 1.
      const elapsedMs = now - session.startedAtMs - introMs;
      const progress = session.durationMs === 0 || elapsedMs >= routeMs - 1e-6
        ? 1
        : Math.max(0, elapsedMs / Math.max(1, routeMs));
      const geometry = projectedTravelGeometry(
        map,
        session.origin,
        session.destination,
        reducedMotion
      );
      renderTravelRoute(route, geometry, progress);
      // Hide the route while either end is on the far side of the globe.
      const camera = mapGlobeCamera(map);
      route.root.style.visibility = camera && (
        !isSurfacePointOnNearSide(camera, session.origin.lon, session.origin.lat) ||
        !isSurfacePointOnNearSide(camera, session.destination.lon, session.destination.lat)
      ) ? "hidden" : "";
      const point = quadraticPoint(geometry, progress);
      const geographicPoint = map.unproject([point.x, point.y]);
      playerMarkerRef.current?.setLngLat([
        geographicPoint.lng,
        geographicPoint.lat
      ]);
      const nextRemainingMs = Math.max(
        0,
        session.durationMs - (now - session.startedAtMs)
      );
      const nextRemainingSecond = Math.ceil(nextRemainingMs / 1_000);
      if (nextRemainingSecond !== remainingSecondRef.current) {
        remainingSecondRef.current = nextRemainingSecond;
        setRemainingMs(nextRemainingMs);
      }
      if (progress >= 1) {
        // The route is screen-space: drop it (and the pulse) the moment the trip ends so
        // it can't hang frozen while the arrival camera moves.
        route.root.remove();
        destinationMarker.remove();
        if (!presentationReported) {
          presentationReported = true;
          onPresentationCompleteRef.current(session.requestId);
        }
        return;
      }
      frameId = window.requestAnimationFrame(renderFrame);
    };

    frameId = window.requestAnimationFrame(renderFrame);
    return () => {
      if (frameId !== null) window.cancelAnimationFrame(frameId);
      destinationMarker.remove();
      if (travelMarkerRef.current === destinationMarker) travelMarkerRef.current = null;
      route.root.remove();
      setWorldMapInteractionLocked(map, false);
    };
  }, [
    activeRequestId,
    mapReady,
    mapRevision,
    reducedMotion,
    routeLayoutRevision
  ]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    return bindGlobeMarkerOcclusion(map, () => [
      ...markersRef.current,
      ...socialMarkersRef.current,
      ...(playerMarkerRef.current ? [playerMarkerRef.current] : []),
      ...(travelMarkerRef.current ? [travelMarkerRef.current] : [])
    ]);
  }, [mapReady, mapRevision]);

  useEffect(() => {
    if (travelState.phase !== "arriving") return;
    const map = instanceRef.current?.map;
    if (map) {
      // Settle on the destination at a moderate zoom before handing back.
      const destination = travelState.destination;
      map.stop();
      const target = {
        center: [destination.lon, destination.lat] as [number, number],
        zoom: worldMapTravelArrivalZoom(map.getZoom())
      };
      if (reducedMotion) map.jumpTo(target);
      else map.easeTo({ ...target, duration: WORLD_MAP_ARRIVAL_MS, essential: true });
    }
    const timer = window.setTimeout(onArrivalComplete, WORLD_MAP_ARRIVAL_MS);
    return () => window.clearTimeout(timer);
  }, [onArrivalComplete, reducedMotion, travelState.phase]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    const handleMoveEnd = (): void => {
      setClusterPickerId(null);
      setMarkerLayoutRevision((current) => current + 1);
    };
    map.on("moveend", handleMoveEnd);
    map.on("projectiontransition", handleMoveEnd);
    return () => {
      map.off("moveend", handleMoveEnd);
      map.off("projectiontransition", handleMoveEnd);
    };
  }, [mapReady, mapRevision]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    // Far-side destinations project onto the near disc; cluster only what faces the camera.
    const camera = mapGlobeCamera(map);
    const facing = camera
      ? mapDestinations.filter((destination) =>
        isSurfacePointOnNearSide(camera, destination.lon, destination.lat))
      : mapDestinations;
    const tier = worldMapMarkerTier(map.getZoom());
    // Hubs may merge into a count marker at far zoom only; from mid zoom in they stay individual.
    const groups = clusterWorldMapDestinations(
      facing,
      (destination) => map.project([destination.lon, destination.lat]),
      tier === "far" ? WORLD_MAP_FAR_CLUSTER_RADIUS_PX : undefined,
      tier === "far" ? undefined : isMajorHub
    );
    const markers: maplibregl.Marker[] = [];
    for (const group of groups) {
      const selectedDestination = group.destinations.find(
        (destination) => destinationKey(destination) === selectedId
      ) ?? null;
      if (group.destinations.length > 1) {
        const element = createGroupMarkerElement(
          group.destinations,
          selectedDestination,
          () => {
            if (travelActive) return;
            setClusterPickerId(group.id);
          }
        );
        setMarkerTravelLocked(element, travelActive);
        const center = map.unproject([group.screenCenter.x, group.screenCenter.y]);
        markers.push(new maplibregl.Marker({
          element,
          anchor: "center",
          opacityWhenCovered: 1
        })
          .setLngLat([center.lng, center.lat])
          .addTo(map));
        continue;
      }
      for (const destination of group.destinations) {
        const select = (): void => {
          if (travelActive) return;
          setClusterPickerId(null);
          setSelectedId(destinationKey(destination));
        };
        const element = tier === "far"
          ? createDestinationDotElement(destination, destinationKey(destination) === selectedId, select)
          : createDestinationMarkerElement(
            destination,
            destinationKey(destination) === selectedId,
            map.getZoom(),
            select
          );
        setMarkerTravelLocked(element, travelActive);
        markers.push(new maplibregl.Marker({
          element,
          anchor: "center",
          opacityWhenCovered: 1
        })
          .setLngLat([destination.lon, destination.lat])
          .addTo(map));
      }
    }
    markersRef.current = markers;
    map.triggerRepaint();
    return () => {
      for (const marker of markers) marker.remove();
      markersRef.current = [];
    };
  }, [
    mapDestinations,
    mapReady,
    mapRevision,
    markerLayoutRevision,
    pngMasterScale,
    selectedId,
    travelActive
  ]);

  // The player's marker never joins a cluster; when it sits on a destination it
  // steps aside so both stay readable and tappable.
  useEffect(() => {
    const map = instanceRef.current?.map;
    const player = playerMarkerRef.current;
    if (!map || !mapReady || !player) return;
    const own = map.project([fallbackCenter.lon, fallbackCenter.lat]);
    const camera = mapGlobeCamera(map);
    const far = worldMapMarkerTier(map.getZoom()) === "far";
    // Anything within the marker footprint (a dot/cluster ~30px, an icon ~50px, plus the
    // sprite) pushes the player to a fixed side so the two never overlap.
    const overlapRadius = far ? 40 : 56;
    const overlapped = !travelActive && mapDestinations.some((destination) => {
      if (camera && !isSurfacePointOnNearSide(camera, destination.lon, destination.lat)) return false;
      const point = map.project([destination.lon, destination.lat]);
      return Math.hypot(point.x - own.x, point.y - own.y) < overlapRadius;
    });
    playerMarkerElementRef.current?.outer.classList.toggle("world-map-player-marker--far", far);
    player.setOffset(overlapped ? [far ? -34 : -46, 0] : [0, 0]);
  }, [
    fallbackCenter.lat,
    fallbackCenter.lon,
    mapDestinations,
    mapReady,
    mapRevision,
    markerLayoutRevision,
    travelActive
  ]);

  const socialPlayers = useMemo(
    () => snapshot?.socialPlayers ?? [],
    [snapshot]
  );

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    const elements = socialPlayers.map((player) => createWorldMapPlayerMarkerElement(
      player.displayColor ?? null,
      player.appearance,
      {
        ariaLabel: `${player.username} approximate location`,
        className: "world-map-player-marker world-map-social-player-marker",
        label: player.username,
        local: false,
        scaleMultiplier: WORLD_MAP_REMOTE_PLAYER_SCALE
      }
    ));
    const markers = socialPlayers.map((player, index) => new maplibregl.Marker({
      element: elements[index]!.outer,
      anchor: "bottom",
      opacityWhenCovered: 1
    })
      .setLngLat([player.lon, player.lat])
      .addTo(map));
    socialMarkersRef.current = markers;
    map.triggerRepaint();
    socialMarkerElementsRef.current = elements;
    return () => {
      for (const marker of markers) marker.remove();
      for (const element of elements) element.destroy();
      if (socialMarkersRef.current === markers) socialMarkersRef.current = [];
      if (socialMarkerElementsRef.current === elements) socialMarkerElementsRef.current = [];
    };
  }, [mapReady, mapRevision, socialPlayers]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady || caves.length === 0) return;
    const markers = caves.map((cave) => {
      const element = document.createElement("div");
      element.className = "world-map-marker world-map-marker--map-marker world-map-marker--cave";
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `Cave: ${cave.name}`);
      const pin = document.createElement("span");
      pin.className = "world-map-map-marker-pin";
      pin.setAttribute("aria-hidden", "true");
      const label = document.createElement("strong");
      label.textContent = cave.name;
      element.append(pin, label);
      return new maplibregl.Marker({ element, anchor: "bottom", opacityWhenCovered: 1 })
        .setLngLat([cave.lon, cave.lat])
        .addTo(map);
    });
    map.triggerRepaint();
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [caves, mapReady, mapRevision]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady || mapMarkers.length === 0) return;
    const markers = mapMarkers.map((marker) => {
      const element = document.createElement("div");
      element.className = `world-map-marker world-map-marker--map-marker${marker.id === activeWaypointMarkerId ? " active" : ""}`;
      element.setAttribute("role", "img");
      element.setAttribute("aria-label", `Map marker: ${marker.name}`);
      const pin = document.createElement("span");
      pin.className = "world-map-map-marker-pin";
      pin.setAttribute("aria-hidden", "true");
      const label = document.createElement("strong");
      label.textContent = marker.name;
      element.append(pin, label);
      return new maplibregl.Marker({ element, anchor: "bottom", opacityWhenCovered: 1 })
        .setLngLat([marker.lon, marker.lat])
        .addTo(map);
    });
    map.triggerRepaint();
    return () => {
      for (const marker of markers) marker.remove();
    };
  }, [activeWaypointMarkerId, mapMarkers, mapReady, mapRevision]);

  useEffect(() => {
    const map = instanceRef.current?.map;
    if (!map || !mapReady) return;
    const canvas = map.getCanvas();
    canvas.style.cursor = teleportMode === "targeting" && !travelActive ? "crosshair" : "";
    const handleClick = (event: maplibregl.MapMouseEvent): void => {
      if (isWorldMapInteractiveTarget(event.originalEvent?.target)) return;
      setClusterPickerId(null);
      if (teleportMode !== "targeting" || travelActive) return;
      onTeleportTarget(event.lngLat.lat, event.lngLat.lng);
    };
    const handleContextMenu = (event: maplibregl.MapMouseEvent): void => {
      if (teleportMode === "idle") return;
      event.preventDefault();
      onCancelTeleport();
    };
    map.on("click", handleClick);
    map.on("contextmenu", handleContextMenu);
    return () => {
      canvas.style.cursor = "";
      map.off("click", handleClick);
      map.off("contextmenu", handleContextMenu);
    };
  }, [mapReady, mapRevision, onCancelTeleport, onTeleportTarget, teleportMode, travelActive]);

  const handleEscape = useCallback((): void => {
    if (searchOpen) {
      setSearchOpen(false);
      return;
    }
    if (layerMenuOpen) {
      setLayerMenuOpen(false);
      return;
    }
    if (socialMenuOpen) {
      setSocialMenuOpen(false);
      return;
    }
    if (clusterPickerId) {
      setClusterPickerId(null);
      return;
    }
    if (travelState.phase === "travelling") {
      onCancelTravel();
      return;
    }
    if (travelActive) return;
    if (teleportMode !== "idle") {
      onCancelTeleport();
    } else {
      onClose();
    }
  }, [
    clusterPickerId,
    layerMenuOpen,
    onCancelTeleport,
    onCancelTravel,
    onClose,
    searchOpen,
    socialMenuOpen,
    teleportMode,
    travelActive,
    travelState.phase
  ]);

  const desktopDialogRef = useModalBehavior<HTMLElement>({
    open: open && layout === "desktop",
    onClose: handleEscape
  });

  const focusDestination = useCallback((destination: WorldMapDestination): void => {
    if (travelActive) return;
    const map = instanceRef.current?.map;
    if (!map) return;
    setSearchOpen(false);
    setLayerMenuOpen(false);
    setClusterPickerId(null);
    setSelectedId(destinationKey(destination));
    map.easeTo({
      center: [destination.lon, destination.lat],
      duration: reducedMotion ? 0 : 300
    });
  }, [reducedMotion, travelActive]);

  const requestDestinationTravel = useCallback((destination: WorldMapDestination): boolean => {
    if (travelControlDisabled || travelActive || travelRequestGateRef.current) return false;
    const requestId = onTravel(destination);
    if (!requestId) return false;
    travelRequestGateRef.current = true;
    setTravelRequested(true);
    return true;
  }, [onTravel, travelActive, travelControlDisabled]);

  const changeView = useCallback((next: WorldMapView): void => {
    setView(next);
    storeWorldMapView(next);
    setSearchOpen(false);
    setLayerMenuOpen(false);
    setSocialMenuOpen(false);
    setClusterPickerId(null);
    setSelectedId(null);
  }, []);

  const requestListTravel = useCallback((destination: WorldMapDestination): void => {
    requestDestinationTravel(destination);
  }, [requestDestinationTravel]);

  const recenterWorldMap = useCallback((): void => {
    const map = instanceRef.current?.map;
    if (!map) return;
    const plan = planGlobeMapRecenter({
      center: fallbackCenter,
      currentZoom: map.getZoom(),
      targetZoom: worldMapRecenterTargetZoom(map.getZoom()),
      reducedMotion
    });
    map.stop();
    map.easeTo({
      center: plan.center,
      duration: plan.durationMs,
      easing: plan.easing,
      ...(plan.zoom === undefined ? {} : { zoom: plan.zoom })
    });
  }, [fallbackCenter.lat, fallbackCenter.lon, reducedMotion]);

  const requestSelectedTravel = (): void => {
    if (!selected) return;
    requestDestinationTravel(selected);
  };

  const handleDestinationVisibilityChange = useCallback((
    destination: WorldMapDestination,
    visible: boolean
  ): boolean => {
    if (travelActive || connectionStatus !== "online") return false;
    const accepted = onSetDestinationVisibility(destination, visible);
    if (!accepted) return false;
    if (!visible && destinationKey(destination) === selectedId) {
      setSelectedId(null);
    }
    return true;
  }, [connectionStatus, onSetDestinationVisibility, selectedId, travelActive]);

  const handleSocialVisibilityChange = useCallback((
    audience: WorldMapSocialAudience,
    visible: boolean
  ): void => {
    if (travelActive || connectionStatus !== "online") return;
    if (!onSetSocialVisibility(audience, visible)) return;
    setSocialVisibilityDraft((current) => ({ ...current, [audience]: visible }));
  }, [connectionStatus, onSetSocialVisibility, travelActive]);

  if (!open) return null;
  const travelStatus = worldMapTravelStatus(
    travelState,
    connectionStatus,
    remainingMs
  );
  const layerControl = <WorldMapLayerControl
    layout={layout}
    open={layerMenuOpen}
    activePanelId={activeLayerPanelId}
    activeOverlayGroupId={activeOverlayGroupId}
    selections={overlaySelections}
    error={overlayError}
    onPanelChange={setActiveLayerPanelId}
    onActiveGroupChange={(groupId) => {
      setOverlayError(null);
      setActiveOverlayGroupId(groupId);
    }}
    onCategoryChange={(groupId, categoryId, enabled) => {
      setOverlaySelections((current) => setWorldEnvironmentOverlayCategory(
        current,
        groupId,
        categoryId,
        enabled
      ));
    }}
  />;
  const layerTrigger = <button
    type="button"
    className={`game-app-header-icon-action${layerMenuOpen ? " active" : ""}`}
    aria-label="Layers"
    aria-expanded={layerMenuOpen}
    aria-controls="world-map-layer-menu"
    onClick={() => {
      setSearchOpen(false);
      setSocialMenuOpen(false);
      setClusterPickerId(null);
      setLayerMenuOpen((current) => !current);
    }}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5M3 16l9 5 9-5" />
    </svg>
  </button>;
  const socialControl = <div className="world-map-social-control">
    <button
      type="button"
      className={`game-app-header-icon-action${socialMenuOpen ? " active" : ""}`}
      aria-label="Social visibility"
      aria-expanded={socialMenuOpen}
      aria-controls="world-map-social-menu"
      onClick={() => {
        setLayerMenuOpen(false);
        setSearchOpen(false);
        setClusterPickerId(null);
        setSocialMenuOpen((current) => !current);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle cx="9" cy="10" r="1" fill="currentColor" stroke="none" />
        <circle cx="15" cy="10" r="1" fill="currentColor" stroke="none" />
        <path d="M8 14c1.2 2 6.8 2 8 0" />
      </svg>
    </button>
    {socialMenuOpen ? <section
      id="world-map-social-menu"
      className="world-map-social-menu"
      aria-label="Social visibility"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
    >
      <p>Who may see your coarse map area?</p>
      {socialAudienceLabels.map(({ audience, label }) => <label key={audience}>
        <input
          type="checkbox"
          checked={socialVisibilityDraft[audience]}
          disabled={connectionStatus !== "online" || travelActive}
          onChange={(event) => handleSocialVisibilityChange(audience, event.currentTarget.checked)}
        />
        <span>{label}</span>
      </label>)}
      <small>Updates about every 30 seconds while you play.</small>
    </section> : null}
  </div>;
  const mapControls = <div className="world-map-map-controls">
    <div className="world-map-map-control-buttons">
      {layerTrigger}
    </div>
    {layerControl}
  </div>;
  const headerActions = <div className="world-map-header-shortcuts">
    {listView ? null : <button
      type="button"
      className={`game-app-header-icon-action${searchOpen ? " active" : ""}`}
      aria-label="Search destinations"
      aria-expanded={searchOpen}
      aria-controls="world-map-destination-search"
      disabled={travelActive}
      onClick={() => {
        setLayerMenuOpen(false);
        setSocialMenuOpen(false);
        setClusterPickerId(null);
        setSearchOpen((current) => !current);
      }}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 5 5" />
      </svg>
    </button>}
    {socialControl}
    {onOpenMapMarkers ? <button
      type="button"
      className="game-app-header-icon-action world-map-markers"
      aria-label="Map Markers and Compass"
      title="Map Markers and Compass"
      disabled={travelActive}
      onClick={() => onOpenMapMarkers()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
        <circle cx="12" cy="10" r="2.2" />
      </svg>
    </button> : null}
    {relocateAction ? <button
      type="button"
      className="game-app-header-icon-action world-map-relocate"
      aria-label={[relocateAction.label, relocateAction.disabledReason].filter(Boolean).join(", ")}
      title={relocateAction.disabledReason ?? relocateAction.label}
      disabled={!relocateAction.enabled || travelActive}
      onClick={() => relocateAction.onSelect()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" />
        <path d="m12 5.5 2.4 6.5L12 18.5 9.6 12 12 5.5Z" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2" />
      </svg>
    </button> : null}
  </div>;
  const travelDisabledReason = teleportMode !== "idle"
    ? "Finish or cancel developer teleport targeting first."
    : travelDisabled
      ? connectionStatus === "online"
        ? "Travel is not currently available."
        : "Travel is unavailable while disconnected."
      : null;
  const destinationNotice = snapshot === null ? <p
    className="world-map-destination-notice"
    role={connectionStatus === "online" ? "status" : "alert"}
  >{connectionStatus === "online"
      ? "Loading authorized destinations…"
      : "Destinations are unavailable while offline."}</p> : null;
  const destinationInteraction = layerMenuOpen || searchOpen ? null : clusterPickerDestinations.length > 1 && !travelActive ? (
    <GameTargetPicker
      ariaLabel={`${clusterPickerDestinations.length} nearby destinations`}
      title="Choose Destination"
      choices={clusterPickerDestinations.map((destination) => ({
        key: destinationKey(destination),
        name: destination.name,
        category: destination.kind === "city" && destination.featured ? "Major hub" : destinationLabel(destination.kind)
      }))}
      onSelect={(key) => {
        setSelectedId(key);
        setClusterPickerId(null);
      }}
      onQuickAction={() => undefined}
      onCancel={() => setClusterPickerId(null)}
    />
  ) : selected && !travelActive ? (
    <GameActionPrompt
      title={selected.name}
      category={selected.kind === "city" && selected.featured ? "Major hub" : destinationLabel(selected.kind)}
      artwork={<img src={markerImage(selected.kind)} alt="" aria-hidden="true" />}
      detail={selected.kind === "manor"
        ? null
        : `Travel cost: ${travelHungerCost(
            distanceMeters(fallbackCenter, { lat: selected.lat, lon: selected.lon })
          )} Hunger`}
      message={travelState.phase === "failed" &&
        destinationKey(travelState.destination) === destinationKey(selected)
        ? { text: travelState.message, tone: "error" }
        : null}
      actions={[{
        key: "travel",
        label: "Travel",
        enabled: !travelControlDisabled,
        busy: travelRequested,
        disabledReason: travelDisabledReason,
        onSelect: requestSelectedTravel
      }]}
      onCancel={() => setSelectedId(null)}
    />
  ) : null;
  const destinationSearch = searchOpen && !travelActive ? <WorldMapDestinationSearch
    destinations={destinations}
    visibilityDisabled={connectionStatus !== "online"}
    onSelect={focusDestination}
    onVisibilityChange={handleDestinationVisibilityChange}
    onClose={() => setSearchOpen(false)}
  /> : null;
  const travelPresentation = travelStatus ? <div
    className={`world-map-travel-status${travelState.phase === "failed" ? " world-map-travel-status--error" : ""}`}
    role="status"
    aria-live="polite"
  >
    <span>{travelStatus}</span>
    {travelState.phase === "travelling" ? (
      <button type="button" onClick={onCancelTravel}>Cancel</button>
    ) : null}
  </div> : null;
  const teleportInstruction = teleportMode !== "idle" ? (
    <div className="world-map-teleport-instruction" role="status">
      {teleportMode === "targeting"
        ? "Teleport mode: click the World Map. Press Esc or right-click to cancel."
        : "Teleporting to the authoritative destination…"}
    </div>
  ) : null;
  const viewBar = <div className="world-map-view-bar">
    <GameAppTabs
      variant="subtabs"
      ariaLabel="Map view"
      activeTab={listView ? "list" : "globe"}
      onChange={(id) => changeView(id === "globe" ? "globe" : "list")}
      tabs={[
        { id: "list", label: "List", disabled: travelActive },
        { id: "globe", label: "Globe view", disabled: travelActive }
      ]}
    />
  </div>;
  const listFailure = travelState.phase === "failed" ? travelState.message : null;
  const listPane = listView ? <div className="world-map-destination-list-pane">
    <WorldMapDestinationList
      destinations={destinations}
      origin={fallbackCenter}
      travelDisabled={travelControlDisabled}
      travelDisabledReason={travelDisabledReason}
      travelBusy={travelRequested}
      failureMessage={listFailure}
      notice={destinationNotice}
      onTravel={requestListTravel}
    />
  </div> : null;
  const mapInterface = <>
    {mapControls}
    {destinationSearch}
    <div className="world-map-map-corner-controls">
      <button
        type="button"
        className="game-app-header-icon-action world-map-recenter-control"
        aria-label="Recenter map"
        disabled={travelActive}
        onClick={recenterWorldMap}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      </button>
      {travelPresentation ? null : <WorldZoneReadout readout={zoneReadout} />}
    </div>
    {developerAccessEnabled ? <button type="button" disabled={travelActive} className={teleportMode !== "idle" ? "world-map-dev-trigger active" : "world-map-dev-trigger"} onClick={onOpenDeveloperTools}>DEV</button> : null}
    {destinationNotice}
    {destinationInteraction}
    {travelPresentation}
    {teleportInstruction}
  </>;
  if (layout === "phone") {
    return <PhoneMenuDestinationShell
      menuId="world-map"
      title="Atlas"
      headerAction={headerActions}
      className="world-map-phone-shell"
      bodyClassName="world-map-phone-body"
      onBack={onClose}
      onEscape={handleEscape}
      navigationDisabled={travelActive}
    >
      {onOpenRealmSection ? <RealmAppTabs activeSection="world-map" disabled={travelActive} onChange={onOpenRealmSection} /> : null}
      <div className={`world-map-overlay world-map-overlay--phone-content${developerAccessEnabled ? " world-map-overlay--developer-access" : ""}${developerMenuOpen ? " world-map-overlay--dev-menu-open" : ""}`}>
        <div className="world-map-phone-layout">
          {viewBar}
          <div className={`world-map-phone-map-region${listView ? " world-map-region--list" : ""}`} aria-busy={travelActive}>
            <div ref={containerRef} className="world-map-canvas" />
            {mapInterface}
            {listPane}
          </div>
        </div>
      </div>
    </PhoneMenuDestinationShell>;
  }
  return (
    <section
      ref={desktopDialogRef}
      className={`world-map-overlay phone-destination-shell desktop-destination-shell${developerMenuOpen ? " world-map-overlay--dev-menu-open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="World Map"
      aria-busy={travelActive}
      tabIndex={-1}
    >
      <GameAppHeader
        title="World Map"
        headerAction={headerActions}
      />
      {onOpenRealmSection ? <RealmAppTabs activeSection="world-map" disabled={travelActive} onChange={onOpenRealmSection} /> : null}
      {viewBar}
      <div className={`world-map-desktop-map-region${listView ? " world-map-region--list" : ""}`}>
        <div ref={containerRef} className="world-map-canvas" />
        {mapInterface}
        {listPane}
      </div>
      <GameAppFooter className="desktop-footer-actions world-map-footer">
        <button type="button" className="phone-menu-return" aria-label="Close" disabled={travelActive} onClick={requestMobileMenuReturnToGame}><span className="phone-menu-nav-label">Close</span></button>
      </GameAppFooter>
    </section>
  );
}

function defaultWorldMapSocialVisibility(): WorldMapSocialVisibility {
  return { friends: true, kingdom_members: true, city_members: true };
}

const socialAudienceLabels: ReadonlyArray<Readonly<{
  audience: WorldMapSocialAudience;
  label: string;
}>> = [
  { audience: "friends", label: "Friends" },
  { audience: "kingdom_members", label: "Kingdom Members" },
  { audience: "city_members", label: "City Members" }
];

type DestinationSearchTab = "cities" | "personal" | "kingdom";

function WorldMapDestinationSearch({
  destinations,
  visibilityDisabled,
  onSelect,
  onVisibilityChange,
  onClose
}: Readonly<{
  destinations: readonly WorldMapDestination[];
  visibilityDisabled: boolean;
  onSelect(destination: WorldMapDestination): void;
  onVisibilityChange(destination: WorldMapDestination, visible: boolean): boolean;
  onClose(): void;
}>): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const pendingVisibilityTimeoutsRef = useRef(new Map<string, number>());
  const [tab, setTab] = useState<DestinationSearchTab>("cities");
  const [query, setQuery] = useState("");
  const [pendingVisibility, setPendingVisibility] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const blurSearchInput = (): void => {
      if (document.activeElement === inputRef.current) inputRef.current?.blur();
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "hidden") blurSearchInput();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", blurSearchInput);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", blurSearchInput);
    };
  }, []);
  useEffect(() => {
    setPendingVisibility((current) => {
      let changed = false;
      const next = { ...current };
      for (const destination of destinations) {
        const key = destinationKey(destination);
        if (
          Object.prototype.hasOwnProperty.call(current, key) &&
          current[key] === (destination.visible !== false)
        ) {
          const timeout = pendingVisibilityTimeoutsRef.current.get(key);
          if (timeout !== undefined) window.clearTimeout(timeout);
          pendingVisibilityTimeoutsRef.current.delete(key);
          delete next[key];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [destinations]);
  useEffect(() => () => {
    for (const timeout of pendingVisibilityTimeoutsRef.current.values()) {
      window.clearTimeout(timeout);
    }
    pendingVisibilityTimeoutsRef.current.clear();
  }, []);
  const normalizedQuery = normalizeDestinationSearch(query);
  const results = [...destinations]
    .filter((destination) => destinationSearchTab(destination.kind) === tab)
    .filter((destination) =>
      normalizeDestinationSearch(destination.name).includes(normalizedQuery)
    )
    .sort(compareWorldMapDestinations);
  return <section
    id="world-map-destination-search"
    className="world-map-destination-search"
    role="dialog"
    aria-modal="false"
    aria-label="Search destinations"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}
  >
    <header>
      <h2>Travel destinations</h2>
      <button type="button" aria-label="Close destination search" onClick={onClose}>Close</button>
    </header>
    <label className="world-map-destination-search-input">
      <span className="sr-only">Search travel destinations</span>
      <input
        ref={inputRef}
        type="search"
        value={query}
        placeholder="Search destinations"
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
    </label>
    <div className="world-map-destination-search-tabs" role="tablist" aria-label="Destination types">
      {(["cities", "personal", "kingdom"] as const).map((candidate) => <button
        key={candidate}
        type="button"
        role="tab"
        aria-selected={candidate === tab}
        className={candidate === tab ? "active" : ""}
        onClick={() => setTab(candidate)}
      >{candidate[0]!.toUpperCase() + candidate.slice(1)}</button>)}
    </div>
    <div
      className="world-map-destination-search-results"
      role="tabpanel"
      aria-label={`${tab} destinations`}
    >
      {results.length > 0 ? results.map((destination) => <div
        className="world-map-destination-search-row"
        key={destinationKey(destination)}
      >
        <button
          className="world-map-destination-search-target"
          type="button"
          onClick={() => onSelect(destination)}
        >
          <strong>{destination.name}</strong>
          <small>{destinationLabel(destination.kind)}</small>
        </button>
        <label className="world-map-destination-search-visibility">
          <span className="sr-only">Show {destination.name} on World Map</span>
          <input
            type="checkbox"
            checked={pendingVisibility[destinationKey(destination)] ?? destination.visible !== false}
            disabled={visibilityDisabled || Object.prototype.hasOwnProperty.call(
              pendingVisibility,
              destinationKey(destination)
            )}
            onChange={(event) => {
              const key = destinationKey(destination);
              const visible = event.currentTarget.checked;
              if (!onVisibilityChange(destination, visible)) return;
              setPendingVisibility((current) => ({ ...current, [key]: visible }));
              const previousTimeout = pendingVisibilityTimeoutsRef.current.get(key);
              if (previousTimeout !== undefined) window.clearTimeout(previousTimeout);
              pendingVisibilityTimeoutsRef.current.set(key, window.setTimeout(() => {
                pendingVisibilityTimeoutsRef.current.delete(key);
                setPendingVisibility((current) => {
                  if (!Object.prototype.hasOwnProperty.call(current, key)) return current;
                  const next = { ...current };
                  delete next[key];
                  return next;
                });
              }, 5_000));
            }}
          />
        </label>
      </div>) : <p>No matching destinations.</p>}
    </div>
  </section>;
}

function destinationSearchTab(
  kind: WorldMapDestination["kind"]
): DestinationSearchTab {
  if (kind === "city") return "cities";
  if (kind === "kingdom") return "kingdom";
  return "personal";
}

function normalizeDestinationSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}

function destinationKey(destination: WorldMapDestination): string {
  return `${destination.kind}:${destination.id}`;
}

function isWorldMapInteractiveTarget(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest(
    ".maplibregl-marker, .maplibregl-ctrl, .world-map-map-controls, .world-map-map-corner-controls, .world-map-layer-control, .world-map-destination-search, .game-compact-prompt"
  ));
}

function destinationLabel(kind: WorldMapDestination["kind"]): string {
  if (kind === "city") return "City";
  if (kind === "manor") return "Your manor";
  if (kind === "atlas_shrine") return "Your Atlas Shrine";
  if (kind === "hollin_hut") return "Hollin Hut";
  if (kind === "pathfinder_mark") return "Marked building";
  return "Current Castle";
}

function markerImage(kind: WorldMapDestination["kind"]): string {
  if (kind === "city") return cityMarkerUrl;
  if (kind === "manor") return manorMarkerUrl;
  if (kind === "atlas_shrine") return atlasShrineMarkerUrl;
  // Placeholder marker art for Hollin Huts: reuses the city marker until real art exists.
  if (kind === "hollin_hut" || kind === "pathfinder_mark") return cityMarkerUrl;
  return kingdomSeatMarkerUrl;
}

export type WorldMapMarkerTier = "far" | "mid" | "close";
/** Below this zoom destinations are dots; from here up they are small building icons. */
export const WORLD_MAP_ICON_MIN_ZOOM = 5;
export const WORLD_MAP_FAR_CLUSTER_RADIUS_PX = 30;

export function worldMapMarkerTier(zoom: number): WorldMapMarkerTier {
  if (zoom < WORLD_MAP_ICON_MIN_ZOOM) return "far";
  return zoom < WORLD_MAP_LABEL_MIN_ZOOM ? "mid" : "close";
}

function isMajorHub(destination: WorldMapDestination): boolean {
  return destination.kind === "city" && Boolean(destination.featured);
}

function createHubBadge(sizePx: number): SVGSVGElement {
  const badge = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  badge.setAttribute("viewBox", "0 0 24 24");
  badge.setAttribute("class", "world-map-marker-hub");
  badge.setAttribute("aria-hidden", "true");
  badge.style.width = `${sizePx}px`;
  badge.style.height = `${sizePx}px`;
  const glyph = document.createElementNS("http://www.w3.org/2000/svg", "path");
  glyph.setAttribute("d", HUB_GLYPH_PATH);
  badge.append(glyph);
  return badge;
}

/** Far zoom: a small dot instead of building art; hubs are a larger bronze dot with the hub glyph. */
function createDestinationDotElement(
  destination: WorldMapDestination,
  selected: boolean,
  onSelect: () => void
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  const hub = isMajorHub(destination);
  element.className = `world-map-marker world-map-marker--dot${hub ? " world-map-marker--hub" : ""}${selected ? " selected" : ""}`;
  element.setAttribute("aria-label", destination.name);
  element.setAttribute("aria-pressed", String(selected));
  element.dataset.destinationId = destination.id;
  element.dataset.labelVisible = "false";
  element.style.width = "44px";
  element.style.height = "44px";
  const dot = document.createElement("span");
  dot.className = "world-map-marker-dot";
  if (hub) dot.append(createHubBadge(14));
  element.append(dot);
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect();
  });
  return element;
}

/** Names appear only once markers are far enough apart not to collide (~50-100 km apart). */
export const WORLD_MAP_LABEL_MIN_ZOOM = 7.5;

/** Icons shrink toward the globe view so neighbouring destinations do not pile up. */
export function worldMapMarkerScale(zoom: number): number {
  return Math.max(0.55, Math.min(1, 0.55 + (zoom - 3) * 0.15));
}

function createDestinationMarkerElement(
  destination: WorldMapDestination,
  selected: boolean,
  zoom: number,
  onSelect: () => void
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `world-map-marker world-map-marker--destination world-map-marker--${destination.kind}${selected ? " selected" : ""}`;
  element.setAttribute("aria-label", destination.name);
  element.setAttribute("aria-pressed", String(selected));
  element.dataset.destinationId = destination.id;
  element.dataset.labelVisible = String(zoom >= WORLD_MAP_LABEL_MIN_ZOOM);
  const image = document.createElement("img");
  image.src = markerImage(destination.kind);
  const presentation = worldMapMarkerPresentation(destination.kind);
  const fixedDimensions = fixedWorldPngDimensions(presentation);
  const scale = worldMapMarkerScale(zoom);
  const dimensions = {
    width: Math.round(fixedDimensions.width * scale),
    height: Math.round(fixedDimensions.height * scale)
  };
  element.style.width = `${Math.max(44, dimensions.width)}px`;
  element.style.height = `${Math.max(44, dimensions.height)}px`;
  element.style.setProperty(
    "--world-map-marker-image-height",
    `${dimensions.height}px`
  );
  image.style.width = `${dimensions.width}px`;
  image.style.height = `${dimensions.height}px`;
  image.alt = "";
  image.setAttribute("aria-hidden", "true");
  const label = document.createElement("strong");
  label.textContent = destination.name;
  element.append(image, label);
  if (isMajorHub(destination)) {
    element.append(createHubBadge(Math.round(Math.max(14, 22 * scale))));
  }
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onSelect();
  });
  return element;
}

function worldMapMarkerPresentation(
  kind: WorldMapDestination["kind"]
): FixedWorldPngPresentation {
  if (kind === "city") return WORLD_PNG_PRESENTATION.worldMapCity;
  if (kind === "kingdom") return WORLD_PNG_PRESENTATION.worldMapKingdom;
  if (kind === "manor") return WORLD_PNG_PRESENTATION.worldMapManor;
  return WORLD_PNG_PRESENTATION.worldMapAtlasShrine;
}

function createGroupMarkerElement(
  destinations: readonly WorldMapDestination[],
  selectedDestination: WorldMapDestination | null,
  onActivate: () => void
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `world-map-marker world-map-marker--group${selectedDestination ? " selected" : ""}`;
  element.setAttribute(
    "aria-label",
    `${destinations.length} nearby destinations. Choose a destination.${selectedDestination
      ? ` Selected destination: ${selectedDestination.name}.`
      : ""}`
  );
  element.setAttribute("aria-haspopup", "dialog");
  const cluster = document.createElement("span");
  cluster.className = "world-map-marker-cluster";
  const count = document.createElement("b");
  count.textContent = `×${destinations.length}`;
  cluster.append(count);
  if (destinations.some(isMajorHub)) cluster.append(createHubBadge(14));
  element.append(cluster);
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onActivate();
  });
  return element;
}

function setMarkerTravelLocked(
  element: HTMLButtonElement,
  travelLocked: boolean
): void {
  element.setAttribute("aria-disabled", String(travelLocked));
  element.dataset.travelLocked = String(travelLocked);
  element.tabIndex = travelLocked ? -1 : 0;
}

type ProjectedTravelGeometry = Readonly<{
  origin: { x: number; y: number };
  control: { x: number; y: number };
  destination: { x: number; y: number };
}>;

type TravelRouteElement = Readonly<{
  root: SVGSVGElement;
  fullPath: SVGPathElement;
  completedPath: SVGPathElement;
}>;

function projectedTravelGeometry(
  map: Pick<maplibregl.Map, "project">,
  origin: LatLon,
  destination: LatLon,
  reducedMotion: boolean
): ProjectedTravelGeometry {
  const projectedOrigin = map.project([origin.lon, origin.lat]);
  const projectedDestination = map.project([destination.lon, destination.lat]);
  const distance = Math.hypot(
    projectedDestination.x - projectedOrigin.x,
    projectedDestination.y - projectedOrigin.y
  );
  const arcHeight = reducedMotion
    ? 0
    : Math.max(34, Math.min(150, distance * 0.22));
  return {
    origin: projectedOrigin,
    control: {
      x: (projectedOrigin.x + projectedDestination.x) / 2,
      y: (projectedOrigin.y + projectedDestination.y) / 2 - arcHeight
    },
    destination: projectedDestination
  };
}

function quadraticPoint(
  geometry: ProjectedTravelGeometry,
  progress: number
): { x: number; y: number } {
  const inverse = 1 - progress;
  return {
    x: inverse * inverse * geometry.origin.x +
      2 * inverse * progress * geometry.control.x +
      progress * progress * geometry.destination.x,
    y: inverse * inverse * geometry.origin.y +
      2 * inverse * progress * geometry.control.y +
      progress * progress * geometry.destination.y
  };
}

function createTravelRouteElement(container: HTMLElement): TravelRouteElement {
  const namespace = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(namespace, "svg");
  root.classList.add("world-map-travel-route");
  root.setAttribute("aria-hidden", "true");
  const fullPath = document.createElementNS(namespace, "path");
  fullPath.classList.add("world-map-travel-route-full");
  const completedPath = document.createElementNS(namespace, "path");
  completedPath.classList.add("world-map-travel-route-completed");
  completedPath.setAttribute("pathLength", "1");
  root.append(fullPath, completedPath);
  container.append(root);
  return { root, fullPath, completedPath };
}

function renderTravelRoute(
  route: TravelRouteElement,
  geometry: ProjectedTravelGeometry,
  progress: number
): void {
  const parent = route.root.parentElement;
  route.root.setAttribute(
    "viewBox",
    `0 0 ${Math.max(1, parent?.clientWidth ?? 1)} ${Math.max(1, parent?.clientHeight ?? 1)}`
  );
  const path = `M ${geometry.origin.x} ${geometry.origin.y} Q ${geometry.control.x} ${geometry.control.y} ${geometry.destination.x} ${geometry.destination.y}`;
  route.fullPath.setAttribute("d", path);
  route.completedPath.setAttribute("d", path);
  route.completedPath.style.strokeDasharray = "1";
  route.completedPath.style.strokeDashoffset = String(1 - progress);
}

function createDestinationPulseElement(): HTMLDivElement {
  const element = document.createElement("div");
  element.className = "world-map-travel-destination-pulse";
  element.setAttribute("aria-hidden", "true");
  return element;
}

function setWorldMapInteractionLocked(
  map: maplibregl.Map,
  locked: boolean
): void {
  const handlers = [
    map.dragPan,
    map.scrollZoom,
    map.boxZoom,
    map.keyboard,
    map.touchZoomRotate
  ];
  for (const handler of handlers) {
    if (locked) handler.disable();
    else handler.enable();
  }
  if (!locked) map.touchZoomRotate.disableRotation();
}

function worldMapTravelStatus(
  state: WorldMapTravelState,
  connectionStatus: NonNullable<Props["connectionStatus"]>,
  remainingMs: number
): string | null {
  if (state.phase === "idle") return null;
  if (state.phase === "failed") return state.message;
  if (state.phase === "arriving") {
    return `Arriving at ${state.destination.name}…`;
  }
  if (state.phase === "preparing") {
    return `Preparing destination… ${state.destination.name}`;
  }
  const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (connectionStatus !== "online") {
    return `${state.destination.name} · Reconnecting… ${remainingSeconds} seconds remaining`;
  }
  return `${state.destination.name} · ${remainingSeconds} seconds remaining`;
}

function applyPlayerMarkerState(
  element: WorldMapPlayerMarkerElement,
  state: WorldMapTravelState,
  reducedMotion: boolean
): void {
  element.outer.classList.toggle("world-map-player-marker--travelling", state.phase === "travelling");
  element.outer.classList.toggle("world-map-player-marker--preparing", state.phase === "preparing");
  element.outer.classList.toggle("world-map-player-marker--arriving", state.phase === "arriving");
  element.outer.classList.toggle("world-map-player-marker--failed", state.phase === "failed");
  element.outer.classList.toggle("world-map-player-marker--reduced-motion", reducedMotion);
}
