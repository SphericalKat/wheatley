class Wheatley < Formula
  desc "Persistent personal AI agent with a daemon, a CLI, and a dashboard"
  homepage "https://github.com/SphericalKat/wheatley"
  url "https://github.com/SphericalKat/wheatley/releases/download/v@VERSION@/wheatley-ai-cli-@VERSION@.tgz"
  sha256 "@SHA256@"
  license "ISC"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_equal version.to_s, shell_output("#{bin}/wheatley --version").strip
  end
end
