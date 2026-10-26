// Ejected from @docusaurus/theme-mermaid so each color mode gets its own
// themeVariables. The stock component shares one options object across modes.
import React, {useEffect, useMemo, useRef, useState} from 'react';
import ErrorBoundary from '@docusaurus/ErrorBoundary';
import {
  ErrorBoundaryErrorMessageFallback,
  useColorMode,
} from '@docusaurus/theme-common';
import {
  MermaidContainerClassName,
  useMermaidConfig,
  useMermaidRenderResult,
} from '@docusaurus/theme-mermaid/client';
import styles from './styles.module.css';

const fontFamily = "'Inter', system-ui, sans-serif";

// The violet and mint palette of the logo, the same as src/css/custom.css.
const palettes = {
  light: {
    darkMode: false,
    fontFamily,
    background: '#ffffff',
    primaryColor: '#f1e8fe',
    primaryTextColor: '#1c0f33',
    primaryBorderColor: '#8b50ef',
    secondaryColor: '#f8f4ff',
    tertiaryColor: '#f8f4ff',
    mainBkg: '#f1e8fe',
    nodeBorder: '#8b50ef',
    textColor: '#1c0f33',
    titleColor: '#1c0f33',
    lineColor: '#13a07a',
    clusterBkg: '#f8f4ff',
    clusterBorder: '#cdb4f8',
    edgeLabelBackground: '#ffffff',
    noteBkgColor: '#e9fbf4',
    noteBorderColor: '#8fe3c6',
    noteTextColor: '#1c0f33',
    actorBkg: '#f1e8fe',
    actorBorder: '#8b50ef',
    actorTextColor: '#1c0f33',
    actorLineColor: '#cdb4f8',
    signalColor: '#13a07a',
    signalTextColor: '#1c0f33',
    labelBoxBkgColor: '#f8f4ff',
    labelBoxBorderColor: '#cdb4f8',
    labelTextColor: '#1c0f33',
    loopTextColor: '#1c0f33',
    activationBkgColor: '#e3d3fd',
    activationBorderColor: '#7c3aed',
    stateBkg: '#f1e8fe',
    stateBorder: '#8b50ef',
    compositeBackground: '#f8f4ff',
    compositeTitleBackground: '#f1e8fe',
    altBackground: '#f8f4ff',
    transitionColor: '#13a07a',
    transitionLabelColor: '#1c0f33',
    specialStateColor: '#13a07a',
    innerEndBackground: '#13a07a',
  },
  dark: {
    darkMode: true,
    fontFamily,
    background: '#120d1a',
    primaryColor: '#2a1a42',
    primaryTextColor: '#f6f3fb',
    primaryBorderColor: '#a64bf6',
    secondaryColor: '#1a1324',
    tertiaryColor: '#1a1324',
    mainBkg: '#2a1a42',
    nodeBorder: '#a64bf6',
    textColor: '#f6f3fb',
    titleColor: '#f6f3fb',
    lineColor: '#3ee6b0',
    clusterBkg: '#1a1324',
    clusterBorder: '#4a3466',
    edgeLabelBackground: '#120d1a',
    noteBkgColor: '#10261f',
    noteBorderColor: '#1f7a5c',
    noteTextColor: '#f6f3fb',
    actorBkg: '#2a1a42',
    actorBorder: '#a64bf6',
    actorTextColor: '#f6f3fb',
    actorLineColor: '#4a3466',
    signalColor: '#3ee6b0',
    signalTextColor: '#f6f3fb',
    labelBoxBkgColor: '#1a1324',
    labelBoxBorderColor: '#4a3466',
    labelTextColor: '#f6f3fb',
    loopTextColor: '#f6f3fb',
    activationBkgColor: '#352154',
    activationBorderColor: '#3ee6b0',
    stateBkg: '#2a1a42',
    stateBorder: '#a64bf6',
    compositeBackground: '#1a1324',
    compositeTitleBackground: '#2a1a42',
    altBackground: '#1a1324',
    transitionColor: '#3ee6b0',
    transitionLabelColor: '#f6f3fb',
    specialStateColor: '#3ee6b0',
    innerEndBackground: '#3ee6b0',
  },
};

// Rounded corners for plain nodes and subgraphs.
const themeCSS = `
  .node rect, .node .label-container { rx: 8px; ry: 8px; }
  .cluster rect { rx: 12px; ry: 12px; }
  .cluster-label .nodeLabel { font-weight: 700; }
`;

function useSolariumMermaidConfig() {
  const {colorMode} = useColorMode();
  const config = useMermaidConfig();
  return useMemo(
    () => ({
      ...config,
      themeVariables: {...palettes[colorMode], ...config.themeVariables},
      themeCSS: `${themeCSS}${config.themeCSS ?? ''}`,
    }),
    [colorMode, config],
  );
}

function MermaidRenderResult({renderResult}) {
  const ref = useRef(null);
  useEffect(() => {
    const div = ref.current;
    renderResult.bindFunctions?.(div);
  }, [renderResult]);
  return (
    <div
      ref={ref}
      className={`${MermaidContainerClassName} ${styles.container}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{__html: renderResult.svg}}
    />
  );
}

function MermaidRenderer({value}) {
  const config = useSolariumMermaidConfig();
  const renderResult = useMermaidRenderResult({text: value, config});
  if (renderResult === null) {
    return null;
  }
  return <MermaidRenderResult renderResult={renderResult} />;
}

// Mermaid measures label text when it renders. If Inter has not loaded yet, it measures the
// fallback font, and the wider Inter labels are cut off. So render after the fonts are ready.
function useFontsReady() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    const fonts = document.fonts;
    if (!fonts) {
      setReady(true);
      return undefined;
    }
    Promise.all([fonts.load("400 16px 'Inter'"), fonts.load("700 16px 'Inter'")])
      .catch(() => {})
      .then(() => fonts.ready)
      .then(() => {
        if (active) {
          setReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  return ready;
}

export default function Mermaid(props) {
  const fontsReady = useFontsReady();
  if (!fontsReady) {
    return null;
  }
  return (
    <ErrorBoundary
      fallback={(params) => <ErrorBoundaryErrorMessageFallback {...params} />}>
      <MermaidRenderer {...props} />
    </ErrorBoundary>
  );
}
