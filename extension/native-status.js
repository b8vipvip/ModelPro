export const RELEASES_URL = 'https://gptlock.mv3.cn/releases';

export function classifyNativeError(error) {
  const message = String(error || '').trim().toLowerCase();
  if (!message) return null;
  if (
    message.includes('specified native messaging host not found')
    || message.includes('native messaging host not found')
    || message.includes('找不到指定的本机消息传递主机')
  ) return 'host_not_installed';
  if (
    message.includes('not allowed to connect')
    || message.includes('access to the specified native messaging host is forbidden')
    || message.includes('forbidden')
  ) return 'origin_not_allowed';
  if (message.includes('error when communicating with the native messaging host')) return 'protocol_error';
  if (
    message.includes('failed to start native messaging host')
    || message.includes('native host has exited')
    || message.includes('access is denied')
  ) return 'host_start_failed';
  return 'connection_failed';
}

export function nativeHelp(errorCode) {
  const messages = {
    host_not_installed: {
      title: '尚未安装本地核心 / Local Core is not installed',
      detail: '只加载浏览器扩展还不够。请运行 GPTWork Windows Setup 或安装 Linux deb，再完全重启浏览器。',
    },
    origin_not_allowed: {
      title: '扩展 ID 未获授权 / Extension ID is not allowed',
      detail: '请使用官方安装目录中的扩展，并运行安装器的“修复浏览器连接”。',
    },
    host_start_failed: {
      title: '本地核心无法启动 / Local Core could not start',
      detail: '请重新运行安装器修复文件与浏览器注册，然后完全重启浏览器。',
    },
    protocol_error: {
      title: '本地通信协议失败 / Native protocol failed',
      detail: '浏览器已找到并启动核心，但协议握手失败。请更新 GPTWork Core 后运行“修复浏览器连接”。',
    },
    connection_failed: {
      title: '本地核心连接失败 / Local Core connection failed',
      detail: '请运行安装器修复浏览器连接，并从本弹窗重新连接。',
    },
  };
  return messages[errorCode] || messages.connection_failed;
}
