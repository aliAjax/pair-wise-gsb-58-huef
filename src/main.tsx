import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";
import "@mantine/dates/styles.css";
import "@mantine/notifications/styles.css";
import "reactflow/dist/style.css";
import { Notifications } from "@mantine/notifications";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { store } from "./app/store";
import { recoverInterruptedBatches } from "./services/decisionEngine";
import "./styles.css";

// 写库中断后重启：从最近完整批次继续，只补未完成项，不产生重复版本或审计
try {
  recoverInterruptedBatches();
} catch (error) {
  // 恢复失败时仍允许打开界面，用户可在审计页手动重试
  console.error("判定批次恢复失败", error);
}

const theme = createTheme({
  primaryColor: "teal",
  defaultRadius: "sm",
  fontFamily:
    '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  headings: {
    fontFamily:
      '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Provider store={store}>
      <MantineProvider theme={theme}>
        <Notifications position="top-right" />
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </MantineProvider>
    </Provider>
  </StrictMode>,
);
