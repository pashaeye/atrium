import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation
// Same drawing as icons/icon.svg: circle r=63 on a 128 grid, radial gradient (objectBoundingBox cx .34 cy .3 r .8).
func render(_ size: Int, _ path: String) {
  let s = CGFloat(size) / 128
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.translateBy(x: 0, y: CGFloat(size)); ctx.scaleBy(x: s, y: -s) // SVG coordinates
  let r: CGFloat = 63, c: CGFloat = 64
  let bx = c - r, bw = 2 * r
  ctx.addEllipse(in: CGRect(x: bx, y: bx, width: bw, height: bw)); ctx.clip()
  func col(_ h: Int) -> CGColor { CGColor(colorSpace: cs, components: [CGFloat((h >> 16) & 255) / 255, CGFloat((h >> 8) & 255) / 255, CGFloat(h & 255) / 255, 1])! }
  let g = CGGradient(colorsSpace: cs, colors: [col(0xFFFFFF), col(0xD6CCFF), col(0x8B6BFF), col(0x4A2FC9), col(0x2A1A80)] as CFArray, locations: [0, 0.22, 0.55, 0.85, 1])!
  let center = CGPoint(x: bx + 0.34 * bw, y: bx + 0.3 * bw)
  ctx.drawRadialGradient(g, startCenter: center, startRadius: 0, endCenter: center, endRadius: 0.8 * bw, options: [.drawsAfterEndLocation])
  let img = ctx.makeImage()!
  let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dest, img, nil); CGImageDestinationFinalize(dest)
}
let out = CommandLine.arguments[1]
for n in [16, 32, 48, 128, 512] { render(n, "\(out)/icon-\(n).png") }
