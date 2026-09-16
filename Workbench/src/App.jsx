import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import { DocumentDrawer } from "./components/DocumentDrawer";
import { SearchPalette } from "./components/SearchPalette";
import { CollectionPage } from "./pages/CollectionPage";
import { DailyHotPage } from "./pages/DailyHotPage";
import { GraphPage } from "./pages/GraphPage";
import { MaterialsPage } from "./pages/MaterialsPage";
import { BooksPage } from "./pages/BooksPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SystemPage } from "./pages/SystemPage";
import { TopicsPage } from "./pages/TopicsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { AiRadarPage } from "./pages/AiRadarPage";
import { LearningPage } from "./pages/LearningPage";
import { ProjectPage } from "./pages/ProjectPage";
import { useVaultSync } from "./hooks/useVaultSync";
import { KnowledgeAssistant } from "./components/KnowledgeAssistant";

const localWorkbench = import.meta.env.VITE_WORKBENCH_HOSTED !== "true";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedDocumentId, setSelectedDocumentId] = useState(null);
  const [readerContext, setReaderContext] = useState(null);
  const [knowledgeOpen, setKnowledgeOpen] = useState(() => new URLSearchParams(window.location.search).get("assistant") === "1");
  const [knowledgeDocument, setKnowledgeDocument] = useState(null);
  useEffect(() => { document.body.classList.toggle("knowledge-open", knowledgeOpen); return () => document.body.classList.remove("knowledge-open"); }, [knowledgeOpen]);
  const vaultSync = useVaultSync(location.pathname);
  const routeRevision = `${location.pathname}:${vaultSync.revision}`;

  useEffect(() => {
    const onKeyDown = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setSearchOpen(false);
    setSelectedDocumentId(null);
    setReaderContext(null);
  }, [location.pathname]);

  const openDocument = useCallback((documentOrId) => {
    const id =
      typeof documentOrId === "string"
        ? documentOrId
        : documentOrId?.id ?? documentOrId?.relativePath;
    if (id) {
      setSelectedDocumentId(id);
      setReaderContext(
        typeof documentOrId === "object" ? documentOrId.readerContext || null : null,
      );
    }
  }, []);

  const appContext = useMemo(
    () => ({
      navigate,
      openDocument,
      openSearch: () => setSearchOpen(true),
    }),
    [navigate, openDocument],
  );

  return (
    <>
      <AppShell onOpenSearch={appContext.openSearch} onOpenKnowledge={localWorkbench ? () => setKnowledgeOpen(true) : undefined} knowledgeOpen={knowledgeOpen} sync={vaultSync}>
        <Routes key={routeRevision}>
          <Route path="/" element={<OverviewPage onOpenDocument={openDocument} />} />
          <Route path="/graph" element={<GraphPage onOpenDocument={openDocument} />} />
          <Route
            path="/wiki"
            element={
              <CollectionPage
                kind="wiki"
                eyebrow="KNOWLEDGE LAYER"
                title="Wiki 层"
                description="结构化知识：来源拆解、概念、框架、诊断与待验证问题。星图的线性视图。"
                onOpenDocument={openDocument}
              />
            }
          />
          <Route
            path="/materials"
            element={<MaterialsPage onOpenDocument={openDocument} />}
          />
          <Route path="/books" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/books/:bookId" element={<BooksPage onOpenDocument={openDocument} />} />
          <Route path="/daily-hot" element={<DailyHotPage />} />
          <Route
            path="/topics"
            element={<TopicsPage onOpenDocument={openDocument} />}
          />
          <Route
            path="/content"
            element={
              <CollectionPage
                kind="content"
                eyebrow="CONTENT PIPELINE"
                title="内容中心"
                onOpenDocument={openDocument}
              />
            }
          />
          <Route path="/system" element={<SystemPage />} />
          {localWorkbench ? <Route path="/projects" element={<ProjectsPage />} /> : null}
          {localWorkbench ? <Route path="/projects/:projectId" element={<ProjectPage onOpenDocument={openDocument} />} /> : null}
{localWorkbench ? <Route path="/ai-radar" element={<AiRadarPage />} /> : null}
{localWorkbench ? <Route path="/learning" element={<LearningPage />} /> : null}
{localWorkbench ? <Route path="/learning/:workspaceId" element={<LearningPage />} /> : null}
          <Route path="*" element={<Navigate replace to="/" />} />
        </Routes>
      </AppShell>

      <SearchPalette
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenDocument={(document) => {
          openDocument(document);
          setSearchOpen(false);
        }}
      />

      <DocumentDrawer
        assistantOpen={knowledgeOpen}
        onAskDocument={localWorkbench ? (document) => { setKnowledgeDocument({ id: document.id, title: document.title, path: document.relativePath, nonce: Date.now() }); setKnowledgeOpen(true); } : undefined}
        documentId={selectedDocumentId}
        onNavigateDocument={openDocument}
        onClose={() => {
          setSelectedDocumentId(null);
          setReaderContext(null);
        }}
        readingContext={readerContext}
      />
      {localWorkbench && <KnowledgeAssistant open={knowledgeOpen} onClose={() => setKnowledgeOpen(false)} incomingDocument={knowledgeDocument} onOpenDocument={(id) => { openDocument(id); if (window.innerWidth < 1100) setKnowledgeOpen(false); }} />}
    </>
  );
}
