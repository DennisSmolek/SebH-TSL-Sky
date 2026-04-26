# Transcript: Atmosphere Rendering Technique in Unreal Engine (Sébastien Hillaire)

**Source:** YouTube video https://www.youtube.com/watch?v=SW30QX1wxTY
**Speaker:** Sébastien Hillaire, Epic Games
**Related paper:** *A Scalable and Production Ready Sky and Atmosphere Rendering Technique* (EGSR 2020)

**Note on this transcript:** Cleaned from YouTube auto-captions. Obvious speech-to-text errors have been corrected inline (e.g., "ielts perspective" → "aerial perspective", "britton"/"brim tone" → "Bruneton", "rematching" → "ray marching", "lot" → "LUT", "pass thresher"/"past rest" → "path tracer", "bare shadow map" → "Beer shadow map", "ta" → "TAA"). Section headings and timestamps preserved from the original captions.

---

## [0:03] Introduction

Hello everyone, I am Sébastien Hillaire and I am going to present to you the atmosphere rendering techniques we have developed in Unreal Engine.

So, what are we talking about? The sky is the result of complex light scattering in particles within the atmosphere. On Earth it has a rich blue color during the day, and features more complex yellow, green and red tones at sunset.

When light scattering happens between objects and your eyes, this physical interaction is called aerial perspective. Those objects then look like they are in a fog. Last but not least, clouds are also part of the atmosphere, also interacting with light and casting volumetric shadows within the atmosphere.

Many other different types of atmosphere exist in space, for example Mars and its blue sunset, or Titan's complex atmosphere. Moreover, other cloud formations can happen within a planet's atmosphere such as cyclones, tornadoes or volcanic plumes.

So the light will scatter several times within the atmosphere before reaching your eyes, and this is an important effect to simulate to achieve rich atmospheric visuals. We cannot take pictures of the real world with and without this phenomenon, so here are some artificial examples actually achieved using path tracing. You can see that on Earth during sunset it is critical to simulate multiple scattering to achieve believable results and avoid a yellowish-looking atmosphere.

At the bottom here, images show that multiple scattering is important for the light to fill up the space between the camera and landscape when inside a volumetric shadow — in this case, this is the result of light scattering around mountains.

Cloud participating media usually have an albedo close to one. As such, light can bounce thousands of times before going out of the cloud at any position. Thus, multiple scattering is a requirement to render clouds that do not look like dark smoke.

---

## [1:48] What do we want?

So we wanted artistic freedom and to be sure the tech is easy to use in the Unreal editor. We wanted high visual quality without objectionable artifacts. We wanted to be close to the ground truth in the way we represent and render the atmosphere and its components, while supporting dynamic time of day and weather.

We also wanted to support views from space, because many industrial applications or games require such a possibility, for visualization or science fiction.

And last but not least, we wanted the technique to be scalable, because our game Fortnite runs on mobile. And we also wanted the atmosphere rendering performance to be decoupled from the screen resolution — for example, crazy 4K.

---

## [2:27] The end result in Unreal Engine

So here are some results we now have in Unreal Engine.

The first video shows the atmosphere being rendered in real time in the editor. The sky is updated each frame, so the atmosphere can be tweaked to match Mars atmosphere without any delay.

The second video shows the view from space of planet Earth with a sunset.

The third video shows that one can seamlessly fly from ground to space, and even represent a tiny planet with soft volumetric shadows from clouds.

And the last video shows some custom cloud material representing a cyclone with exotic colors.

So let's start with sky rendering.

---

## [3:04] Previous work — atmosphere

Several methods have been proposed to render skies. For instance, it is possible to ray march the atmosphere, or fit a mathematical model on sky color itself. However, such models are not taking into account multiple scattering, or do not provide solutions to render the aerial perspective on objects, and do not, for example, support views from space.

A more successful approach to sky rendering are the lookup-table-based models. They have been used successfully in many games with a few simplifications. However, they do have some limitations: some visual artifacts can sometimes be seen at the horizon, and it becomes unavoidable for the atmosphere. The high-dimensional scattering lookup table is expensive to update, and requires iterations to compute the result of N orders of scattering. And also, volumetric shadows from clouds are not directly supported.

So before we dive in the rendering technique, I wanted to mention that we represent atmosphere material the same way as it has been done in previous work. Please refer to our EGSR paper for more details.

---

## [4:03] Inspecting the visual features of skies

So we started by looking at what is really required to render the sky, a bit like when you want to best represent visual features of a BRDF: you have to identify the representative characteristics having a high impact in order to reproduce the target visual.

One can easily notice that the distant sky is of very low frequency. Even the Mie scattering lobe is a soft blob around the sun, and the aerial perspective is also very smooth on screen and in depth. The only high frequencies we can see are the rapid change of atmosphere color near the horizon, and the variation due to volumetric shadows.

And on top of that, we also recognize the importance of multiple scattering in order to faithfully represent atmospheric scattering and achieve more believable visual results.

So from this simple visual analysis, we propose a way to render all these important visual details using a new set of low-resolution LUTs, maintaining high-frequency visual features. These LUTs allow us to also decouple the atmosphere rendering performance from the screen resolution. It makes the technique scalable from mobile to high-end PCs, by simply tweaking the LUT resolution and ray marching sample count.

Now, how can we render an atmosphere? We will use a typical volumetric ray marching, with sample count adjusted based on distance. For each sample we evaluate the light transmitted through the atmosphere, the phase function and atmosphere material, and from that we can deduce the amount of light scattered toward the camera and the transmittance over the background and so on.

Multiple scattering is typically too expensive to do this way, so approximations will be used and I will describe them.

As mentioned previously, we often need to evaluate the light transmitted through the atmosphere to a point. Instead of a secondary ray marching, we use the same lookup table proposed by Bruneton, storing colored transmittance.

---

## [5:53] Transmittance LUT and views from space

By default our rendering technique is optimized for views from the ground. In this case we compute a single transmittance value from the top of the planet to the ground, and it is applied on all entities.

But we also give the option to apply that function per pixel, in order to achieve more realistic space views of a planet and its terminator region. And this can also have the planet itself cast shadows on nearby moons, for instance.

The Sky-View LUT is the new lookup table we propose in order to render the distant sky. It stores the ray marching result using a latitude/longitude mapping. And please note that the latitude mapping is non-linear, in order to maintain the high-frequency colors at the horizon while reducing linear interpolation artifacts. This lookup table can also be used to store the contribution of any number of suns at once.

So we can now render the distant sky as seen here. And the sun disk is composited at this stage.

The aerial perspective lookup table stores luminance and transmittance, and it is evaluated and stored in a volume texture mapped onto the camera frustum, as proposed in some previous work. This can be applied on opaque and translucent surfaces, as you can see here without and with the aerial perspective LUT.

---

## [7:16] Multiple scattering LUT

The evolution of the luminance resulting from multiple scattering is simplified by gathering ideas from previous work from light transport papers for participating media and hair rendering, but this time adapted to atmospheric rendering.

Our physically based approach can approximate the evolution of an infinite number of scattering orders. For the sake of time, please refer to our EGSR paper for more details. But in short, we end up with a two-dimensional lookup table storing the isotropic multiple scattering contribution, and this can be created for any sample within the atmosphere.

Okay, so let's have a look at some results now. We have compared our approach to the state-of-the-art technique from Bruneton and a volumetric path tracer we have developed specifically to be our ground truth.

In short, the comparison shows that our model is close to the ground truth model — meaning close to the state-of-the-art model — for atmospheres close to Earth or Mars. And it is also the only model that can faithfully reproduce the effect of infinite multiple scattering in dense extraterrestrial atmospheres. Please refer to our EGSR paper for more in-depth analysis and also issues related to that lookup table.

---

## [8:26] Performance — PC / Mobile

Here you can see the performance when building those lookup tables we propose on PC or mobile. Please note that the transmittance LUT can also have an even lower resolution on mobile and use fewer samples, if you are willing to accept minor visual differences. And you can see that we get a nice match between high-end PC and the lower-end mobile platforms we support.

On the other hand of the complexity spectrum, we have a working prototype of our reference for atmosphere rendering in Unreal's path tracer. Global illumination here is coming from light scattering on particles within the atmosphere layer, not from a distant map. And from this we get correct global illumination within the atmosphere, as well as proper volumetric shadows and multiple scattering.

Okay, so let's chat a bit about the rendering of clouds within the atmosphere now, because they are key to achieve believable skies.

---

## [9:20] Cloud rendering

Recently, beautiful real-time cloud rendering implementations have successfully shipped in games. Schneider proposed a way to assemble noise primitives to render visually convincing volumetric clouds. Then Bauer presented a method improving this approach, using a unified model rendering nearby volumetric fog and clouds altogether.

However, these methods are relying on static ways to combine noise to represent clouds. They still give artists a lot of flexibility through the exposed parameterization, but we wanted to lift this limitation. In Unreal, the cloud layer is a volumetric material graph that is authored by tech artists, and the workflow can be customized using Unreal's Blueprint.

With that, one can render any cloud shape — for instance tornadoes, or bunny-shaped clouds if you feel like it.

Later I'll also talk about more details, such as multiple scattering, Beer shadow maps, or other visual features.

---

## [10:17] Cloud multiple scattering?

So clouds are rendered using ray marching, but how can we evaluate the multiple scattering contribution? As mentioned before, this phenomenon really defines the distinctive appearance of a cloud. Without multiple scattering, a huge part of the energy is lost, because the participating medium albedo is usually very close to one, meaning that the light is almost never absorbed.

As you can see in this debug representation, a path that needs to be integrated together with scattered luminance according to different phase functions is complex. There has been some work done to solve this in real time, but nothing that seems shippable while respecting the complex visuals of clouds.

So we settled on using the multiple octaves of single scattering approach proposed by Wrenninge.

In this case you can see on this image single scattering only, and I show a path-traced result at the bottom just to give you a visual idea of the ground truth. And this is the result when using two octaves of single scattering. You can see that the light penetrates deeper into the medium, achieving a brighter and more cloud-like appearance.

---

## [11:14] Multiple scattering: dark edges effect?

However, this is not a true multiple scattering simulation, and as such we miss other defining visual features, such as dark edges — being the result of low probability of light scattering towards the eyes in those regions.

Multiple scattering in a high-albedo situation is challenging even for offline rendering, so we have to cheat a bit here, unfortunately. One option is to use the custom transmittance function presented by Schneider, but we prefer to stay physically based and let artists control such effects from the material graph.

We basically recommend to simply lower the albedo near the edge of the cloud. And as you can see on the sketch, rays will travel more in low-albedo regions at the edges of the volume, and that will automatically reveal detailed edges.

And you can see here the subtle effect it brings. You can see dark edges looking like the reference on the top. However, this is like an artistic cheat — it is wrong, but it works and helps visually. So be careful not to overdo it, in order to avoid a dirty smoke look, or a dotted-cotton look of clouds. You do not want that.

---

## [12:29] Cloud droplet Mie scattering

So just to put another nail in the coffin: clouds are not composed of dust or air molecules, they are made of many tiny water droplets resulting from condensation. This results in refraction events, in turn resulting in a complex phase function that is wavelength dependent. It produces many visual features such as sharpening, glory, halo and the dark edges we discussed before.

So if you use an isotropic phase function, it can look too bright; or too dark when using a single strongly forward single-lobe phase function. And you will never be able to render realistic clouds like this one.

I have been able to achieve this rendering using my personal volumetric path tracer running on GPU, and sampling the realistic Mie scattering water droplet phase function you can see on the left. When you use this, you automatically get all of these important cloud visual features with appropriate brightness, from my experience of course.

So there's still research to conduct to get this result in real time, but today I do not have any nice solution to give you apart from the albedo trick I mentioned before.

That being said, it is possible to do the following: generate a complex phase function using the MiePlot software. Then for the sake of real-time performance, that phase function can be used on the single scattering path only, and that at least allows us to recover the fog bow and glory halo visual features, as you can see on the right. And multiple scattering is then simply evaluated using the previously mentioned multiple-octaves-of-single-scattering approach.

---

## [13:55] Toward a better volumetric lighting integrator?

So when ray marching the volumetric data, you need to consider how you integrate the lighting. A few years ago I presented an analytical solution better than Simpson's or trapezoidal integration, because it respects Beer's law over a considered segment. However, it was only supporting a single shadow value for the segment.

Here at Epic I considered improving this, by taking into account a different shadow value per vertex that are linearly interpolated over the segment. You can see the analytical integration there.

You can see here the before-and-after difference — it does help better define the cloud shape, and has some visual artifacts on the top of the cloud in some cases, that you can see on the right. However, we are not using it yet, because it is a bit more expensive, and also a bit unstable due to the division by the squared extinction, which requires some clamping in order to avoid numerical precision issues.

So I look forward to seeing if any of you use this, or if there are even better ideas out there.

---

## [15:01] Cloud volumetric occlusion

So on top of lighting, you also need to take into account occlusion. And cloud occlusion is important to avoid and to render sunlight shafts within the atmosphere — you can see here on the right.

One can use exponential shadow maps like Bauer. In any case, you may have noticed: exponential shadow maps are exactly Beer's law, but with only one constant extinction value for all the pixels. The problem is that it will result in occlusion that will always converge to a transmittance of zero over a large distance.

The problem is illustrated here on this almost-vertical plane receiving cloud shadows from — shadows are getting darker with distance from the cloud layer, you can see. And this is a problem, especially when the sun is at the horizon. And since extinction is constant for all the same texel, there is no right answer here.

So instead, we propose a new occlusion representation we call a Beer shadow map, that is more consistent and avoids the problems I just mentioned.

So here is a comparison between the exponential shadow map and Beer shadow map approaches. The Beer shadow map is basically the transmittance curve of a homogeneous medium with extinction varying per particle. It starts at depth Z and has a clamp on the optical depth to store the transmittance converging towards zero. All of this data is generated while ray marching to generate the Beer shadow domain.

---

## [16:21] Opaque / cloud / atmosphere occlusion

And we can now evaluate volumetric shadows using Beer shadow maps. We can use per-pixel tracing with sample jittering and TAA to achieve sharpness, but at the cost of full-resolution tracing. If this per-pixel tracing cost is prohibitive for your use case, it is possible to simply store the shadows as part of the Sky-View and aerial perspective LUTs. You will then just have to play with the resolution and the sample count in order to achieve good-looking results for your content.

We have also more optional visual features that can be enabled if the user budget allows it. For instance, it is possible to run a secondary trace toward the ground to evaluate its contribution to the ground lighting. This can be very important to help with the perception of the cloud shape, and have some secondary shadows.

It's also possible to have the atmospheric transmittance evaluated for each step we take when integrating the cloud lighting. It results in a more complex and realistic look, especially at sunset, as you can see on the right. So this is with a single transmittance value for all the samples, and this is with more complex transmittance. For example, this matches basically the reference here.

So to recap: first, we have the atmosphere participating media. It can be occluded by clouds. Then we have the cloud participating media that can cast shadow on itself. And the atmosphere is also applied on the clouds.

And just as an example, this is how it looks when you make the atmosphere thicker — it remains consistent.

So you can see here the tech used in the Unreal Engine 5 real-time demo *Lumen in the Land of Nanite*. Physically based does not only mean realistic. You can see at the bottom the result of stylized cloud authoring in a Fortnite cinematic, as well as an experiment that Ryan Brucks has conducted.

---

## [18:08] Conclusion

So to conclude, I have presented to you the atmosphere rendering technique available in Unreal Engine.

It can scale from high performance to high fidelity rendering, and from low-end mobile to high-end platforms. Only cloud rendering is not reasonably achievable on mobile for now.

It supports dynamic atmosphere and time of day, and approximates multiple scattering using physically based approaches. And it can also render views from ground and space.

---

## [18:38] References

So, a few references for you to check out later, and some links interesting for and about this talk.

And basically, that is it. Thank you very much for listening.
