import Docker from 'dockerode';

// DOCKER_HOST / DOCKER_SOCKET_PATH select the target daemon. In this repo's dev
// environment that's the native engine in the Ubuntu WSL2 distro
// (unix:///var/run/docker-native.sock), NOT Docker Desktop's socket — Desktop has
// no /dev/kvm and cannot run dockurr/windows at all (confirmed empirically).
const socketPath = process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker-native.sock';

export const docker = new Docker({ socketPath });
